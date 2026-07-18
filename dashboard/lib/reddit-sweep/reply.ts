// Suggested-reply drafter for the social sweep. One LLM call per post produces a
// ready-to-paste reply in Snagged's voice, channel-aware (X terse, Reddit more
// substantive), from the @snagged accounts. Fail-open: no API key → empty (the UI just
// shows no draft). Nothing is auto-posted.

import { blogVoiceProfile } from "./voice";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.SOCIAL_REPLY_MODEL || process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001";

type DraftInput = { platform: "reddit" | "x"; source: string; title: string; snippet: string; matched: string[]; bucket: "high-signal" | "maybe" };

// Snagged's voice — thoughtful, critical, real. NOT sycophantic. No em dashes.
const SYSTEM = `You write social replies as Snagged (@snagged), a domain brokerage + naming/acquisition firm run by people who broker premium domain deals for a living. You reply to founders, operators, and investors who are talking about domains, naming, or buying a name. You are a genuine domain expert with years of real deals behind you.

VOICE (hard rules):
- Thoughtful, critical, and real. NEVER sycophantic. Do NOT open with "you're totally right", "great post", "this nails it", "love this", or any flattery. Lead with a sharp, specific observation or a mild, fair challenge.
- NO em dashes anywhere. Use periods or commas.
- Plain, confident, conversational. No corporate speak, no hashtags, no sign-off, no "DM us" hard sell. A soft, optional "happy to give you an outside read" only if it genuinely fits.
- Never invent facts about the person, their company, or their domain. If you don't know a detail, don't assert it.
- Weave in ONE piece of real domain/naming expertise relevant to THEIR specific post: e.g. the exact-match .com as positioning/conviction, buying from an unresponsive owner, what a name is actually worth, why a .io/hq/get- name signals hedging, upgrading later costing far more than buying right now.

CHANNEL:
- x: MAX 2 sentences. Punchy, casual, lowercase is fine. A question is fine. No links.
- reddit: 2 to 4 sentences. More substance and one concrete insight, still not salesy. No links unless it reads naturally.

Output ONLY the reply text. No preamble, no quotes, no explanation.`;

function userMsg(d: DraftInput): string {
  const where = d.platform === "x" ? `X (a tweet from ${d.source})` : `Reddit (r/${d.source})`;
  return `Channel: ${d.platform}\nContext: ${where}\nBucket: ${d.bucket === "high-signal" ? "high intent (they may want a broker / to buy)" : "a conversation to add expert value to"}\nWhy it surfaced: ${d.matched.slice(0, 6).join(", ")}\n\nPost:\n"""${`${d.title}\n${d.snippet}`.slice(0, 1200)}"""\n\nWrite the reply now.`;
}

export async function draftReply(d: DraftInput, voice = ""): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "";
  const system = voice
    ? `${SYSTEM}\n\nHere is a sample of Rob's ACTUAL writing from the Snagged blog. Match this exact voice, cadence, sentence rhythm, and point of view. Reuse his real opinions and framings where they fit the post. Do NOT copy sentences verbatim.\n\n<blog>\n${voice}\n</blog>`
    : SYSTEM;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 300, system, messages: [{ role: "user", content: userMsg(d) }] }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return "";
    const j = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text || "").join("").trim();
    // Belt-and-suspenders: strip any em dashes the model slipped in.
    return text.replace(/\s*—\s*/g, ", ").replace(/^["']|["']$/g, "").trim();
  } catch {
    return "";
  }
}

/** Draft replies for many posts with bounded concurrency; fail-open per post. The blog
 *  voice profile is fetched ONCE and shared across all drafts in the run. */
export async function draftReplies<T extends DraftInput>(posts: T[], cap = 50): Promise<Map<T, string>> {
  const out = new Map<T, string>();
  if (!process.env.ANTHROPIC_API_KEY) return out;
  const items = posts.slice(0, cap);
  const voice = await blogVoiceProfile().catch(() => "");
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out.set(items[idx], await draftReply(items[idx], voice)); }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, () => worker()));
  return out;
}
