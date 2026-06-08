// Chat Analytics — a Claude agent (Anthropic Messages API) with tool access to the
// report data layer. Ask a natural-language question ("how many signups last week,
// and did the email send drive it?") and it calls the right tools, correlates the
// numbers, and answers. Server-only; needs ANTHROPIC_API_KEY.

import { analyticsReport, type Tranche } from "./ga";
import { seoReport, type SeoBucket } from "./gsc";
import { revenueReport } from "./revenue";
import { xAdsReport, xAdsConfigured } from "./xads";
import { newsletterReport, recentMemberCounts } from "./mailchimp";
import { histSignups, histUnsubs, mergeDaily, emailDataThrough } from "./historical-email";
import { newOpportunities } from "./opportunities";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CHAT_MODEL || "claude-sonnet-4-6";
const MAX_TOOL_CHARS = 16000; // cap each tool result fed back to the model

export function chatConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const TOOLS = [
  {
    name: "site_analytics",
    description: "Google Analytics for one business line over a date range. tranche: 'core' (the sell-side services site — people hiring Snagged), 'marketplace' (/domains/* type-in domain buyers), or 'blog'. Returns sessions, users, pageviews, form submissions, traffic by channel + source, and for core the self-reported source / lead intent / lead budget / quality-lead breakdowns.",
    input_schema: { type: "object", properties: { tranche: { type: "string", enum: ["core", "marketplace", "blog"] }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } }, required: ["tranche", "from", "to"] },
  },
  {
    name: "seo",
    description: "Google Search Console search performance: top search queries, top pages, clicks/impressions/CTR/avg-position. bucket scopes to a business line: 'all', 'core', 'marketplace', or 'blog'.",
    input_schema: { type: "object", properties: { bucket: { type: "string", enum: ["all", "core", "marketplace", "blog"] }, from: { type: "string" }, to: { type: "string" } }, required: ["bucket", "from", "to"] },
  },
  {
    name: "email",
    description: "Email / newsletter (Mailchimp): subscriber count, avg open/click rate, recent campaigns (titles, send dates, open/click), and daily new-signup vs unsubscribe counts within the range.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "revenue",
    description: "Revenue from the Snagged Domain Tracker over a date range: total revenue, upfront fees vs success fees (counts + $), by month, and by owner.",
    input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "x_ads",
    description: "X (Twitter) paid ads over a date range: total spend (USD), impressions, clicks, engagements, CPC, CPM, CTR, per-campaign spend, a daily spend/clicks trend, and ROI — the X-attributed lead count (self-reported 'X / Twitter' source) and cost-per-lead (spend ÷ X-attributed leads). Use this for 'how much are we spending on X', 'what's our cost per lead on X', or X ad performance questions. X is Snagged's #1 self-reported lead source.",
    input_schema: { type: "object", properties: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } }, required: ["from", "to"] },
  },
  {
    name: "opportunities",
    description: "Current new opportunities: live domain auctions (domain, price, bids, end time) and today's new SNAP candidates (domain, quality, category, price). No arguments.",
    input_schema: { type: "object", properties: {} },
  },
];

type ToolInput = Record<string, string>;
async function runTool(name: string, input: ToolInput): Promise<unknown> {
  if (name === "site_analytics") return analyticsReport(input.tranche as Tranche, input.from, input.to);
  if (name === "seo") return seoReport(input.from, input.to, input.bucket as SeoBucket);
  if (name === "revenue") return revenueReport(input.from, input.to);
  if (name === "x_ads") {
    if (!xAdsConfigured()) return { error: "X Ads not configured (X_ADS_* env vars missing)." };
    return xAdsReport(input.from, input.to);
  }
  if (name === "opportunities") return newOpportunities();
  if (name === "email") {
    let live = { signups: {} as Record<string, number>, unsubs: {} as Record<string, number> };
    let newsletter = null;
    try { live = await recentMemberCounts(emailDataThrough); } catch { /* historical-only */ }
    try { newsletter = await newsletterReport(input.from, input.to); } catch { /* historical-only */ }
    return {
      newsletter,
      signups: mergeDaily(histSignups, live.signups, input.from, input.to),
      unsubs: mergeDaily(histUnsubs, live.unsubs, input.from, input.to),
    };
  }
  return { error: `unknown tool: ${name}` };
}

type Block = { type: string; text?: string; id?: string; name?: string; input?: ToolInput };
type Usage = { input_tokens?: number; output_tokens?: number };
type AnthropicResp = { content?: Block[]; stop_reason?: string; usage?: Usage };
type Msg = { role: "user" | "assistant"; content: string | unknown[] };

export type ChatResult = { answer: string; toolsUsed: string[]; usage: { input: number; output: number } };
export type PriorTurn = { q: string; a: string };

export async function askAnalytics(question: string, today: string, history: PriorTurn[] = []): Promise<ChatResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");

  const system = `You are Snagged's analytics assistant. Today is ${today} (timezone America/New_York).
You answer questions about the business using ONLY the tools provided: site_analytics (Google Analytics), seo (Search Console), email (Mailchimp), revenue (the Domain Tracker), x_ads (X/Twitter paid ad spend + cost-per-lead ROI), and opportunities (live auctions + new SNAP).
Rules:
- Resolve relative dates ("last week", "yesterday", "this month") to explicit YYYY-MM-DD ranges before calling tools. A week is Mon–Sun unless the user says otherwise.
- Call as many tools as needed; when a question links two things (e.g. signups vs an email send), pull both and correlate them explicitly.
- NEVER invent numbers. Only state figures that came from tool results. If a tool returns nothing or data is missing, say so plainly.
- Be concise: lead with the direct answer and the key numbers, then one or two sentences of context. Use $ and % correctly.
The two core businesses: "core" = the sell-side services site (clients hiring Snagged); "marketplace" = /domains/* type-in domain buyers.`;

  // Prior turns as lightweight conversational context (just the text Q&A — not the
  // full tool transcripts — so follow-ups like "what about last month?" work without
  // token bloat). Capped to the most recent few.
  const messages: Msg[] = [];
  for (const h of history.slice(-6)) {
    if (h.q) messages.push({ role: "user", content: h.q });
    if (h.a) messages.push({ role: "assistant", content: h.a });
  }
  messages.push({ role: "user", content: question });
  const toolsUsed: string[] = [];
  let inTok = 0, outTok = 0;

  for (let i = 0; i < 8; i++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools: TOOLS, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as AnthropicResp;
    inTok += data.usage?.input_tokens || 0;
    outTok += data.usage?.output_tokens || 0;
    const content = data.content || [];
    messages.push({ role: "assistant", content });

    if (data.stop_reason === "tool_use") {
      const toolResults: unknown[] = [];
      for (const block of content) {
        if (block.type === "tool_use" && block.id && block.name) {
          toolsUsed.push(block.name);
          let result: unknown;
          try { result = await runTool(block.name, block.input || {}); }
          catch (e) { result = { error: String((e as Error)?.message || e) }; }
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result).slice(0, MAX_TOOL_CHARS) });
        }
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    const answer = content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n").trim();
    return { answer: answer || "(no answer)", toolsUsed, usage: { input: inTok, output: outTok } };
  }
  return { answer: "I couldn't finish the analysis within the step limit — try narrowing the question.", toolsUsed, usage: { input: inTok, output: outTok } };
}
