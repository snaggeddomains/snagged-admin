// Email module — search the deal inbox for a thread, then LLM-draft a reply from its context.
// DRAFT-ONLY: never writes to Gmail. Reads the deal mailboxes via the admin Gmail SA (read-only).
// Gated by the `email` module permission (admins auto-pass).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import {
  dealMailboxes,
  searchMessages,
  getMessage,
  getThreadCapped,
  gmailConfigured,
  type GmailMessage,
} from "@/lib/gmail";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL =
  process.env.EMAIL_ASSIST_MODEL ||
  process.env.OUTREACH_MODEL ||
  process.env.DEAL_RECAP_MODEL ||
  "claude-haiku-4-5-20251001";

type ThreadHit = {
  mailbox: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: number;
  snippet: string;
};

// Search every deal mailbox for a query (a domain, a name, keywords), return the newest
// distinct threads (one row per thread, newest message wins). Light: one search + one
// message fetch per hit stub.
async function searchThreads(q: string, limit = 25): Promise<ThreadHit[]> {
  const byThread = new Map<string, ThreadHit>();
  for (const mb of dealMailboxes()) {
    let stubs: { id: string; threadId: string }[] = [];
    try {
      stubs = await searchMessages(mb, q, 30);
    } catch {
      continue;
    }
    for (const s of stubs) {
      const key = `${mb}:${s.threadId}`;
      if (byThread.has(key)) continue;
      let msg: GmailMessage;
      try {
        msg = await getMessage(mb, s.id);
      } catch {
        continue;
      }
      const prev = byThread.get(key);
      if (!prev || msg.date > prev.date) {
        byThread.set(key, {
          mailbox: mb,
          threadId: s.threadId,
          subject: msg.subject,
          from: msg.from,
          fromName: msg.fromName,
          date: msg.date,
          snippet: msg.snippet || msg.body.slice(0, 200),
        });
      }
      if (byThread.size >= limit * 2) break;
    }
  }
  return [...byThread.values()].sort((a, b) => b.date - a.date).slice(0, limit);
}

// A thread's messages, oldest-first, trimmed for display.
function shapeThread(msgs: GmailMessage[]) {
  return msgs
    .slice()
    .sort((a, b) => a.date - b.date)
    .map((m) => ({
      id: m.id,
      from: m.from,
      fromName: m.fromName,
      to: m.to,
      date: m.date,
      subject: m.subject,
      body: (m.body || m.snippet || "").slice(0, 6000),
    }));
}

const SYSTEM = `You are the domain broker at Snagged (a domain brokerage) drafting a REPLY to the most recent message in an email thread. You write in Snagged's voice: warm but direct, concise, professional, never pushy or salesy. No emdashes. No hype.

Rules:
- Ground the reply ENTIRELY in the actual thread and the drafting instruction. Never invent facts, names, numbers, or commitments not present in one of those.
- If the instruction gives a specific figure or point to make (e.g. "I have a $50k offer"), work it in naturally.
- Match the counterparty by name if their name is clear from the thread; otherwise a neutral greeting.
- Keep it short (a few sentences). Do not restate the whole history.
- Do NOT include a subject line unless asked. Sign off simply (a name placeholder like "[Your name]" if the sender's own name isn't obvious from the thread).
- Return ONLY the email body text, ready to copy/paste. No preamble, no markdown, no quotes around it.`;

function transcript(subject: string, msgs: ReturnType<typeof shapeThread>): string {
  const lines = msgs.map((m) => {
    const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
    const body = (m.body || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    return `--- ${new Date(m.date).toISOString().slice(0, 10)} FROM ${who} TO ${(m.to || "").slice(0, 120)}\n${body}`;
  });
  return `SUBJECT: ${subject}\n\n${lines.join("\n\n")}`;
}

async function draftReply(subject: string, msgs: ReturnType<typeof shapeThread>, instruction: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Drafting is not configured (ANTHROPIC_API_KEY unset).");
  const user = `EMAIL THREAD (oldest first):\n\n${transcript(subject, msgs).slice(0, 18000)}\n\nDRAFTING INSTRUCTION:\n${instruction || "Write a helpful, on-brand reply to the most recent message."}`;
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: SYSTEM, messages: [{ role: "user", content: user }] }),
  });
  const data = (await res.json()) as { content?: { type: string; text?: string }[]; error?: { message?: string } };
  if (data.error) throw new Error(data.error.message || "Draft failed");
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("").trim();
  if (!text) throw new Error("The model returned an empty draft.");
  return text;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 503 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "search";
  return withGmailFeature("email-module", async () => {
    try {
      if (action === "search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return NextResponse.json({ ok: true, threads: [] });
        const threads = await searchThreads(q);
        return NextResponse.json({ ok: true, threads });
      }
      if (action === "thread") {
        const mailbox = url.searchParams.get("mailbox") || "";
        const threadId = url.searchParams.get("thread_id") || "";
        if (!dealMailboxes().includes(mailbox) || !threadId)
          return NextResponse.json({ error: "Bad request" }, { status: 400 });
        const raw = await getThreadCapped(mailbox, threadId);
        if (!raw.length) return NextResponse.json({ error: "Thread too large or empty to load." }, { status: 413 });
        const msgs = shapeThread(raw);
        return NextResponse.json({ ok: true, subject: msgs[msgs.length - 1]?.subject || "", messages: msgs });
      }
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    } catch (e) {
      if (isGmailBudgetError(e)) return NextResponse.json({ error: GMAIL_BUDGET_MESSAGE, budgetPaused: true }, { status: 429 });
      return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail is not configured." }, { status: 503 });

  let body: { action?: string; mailbox?: string; thread_id?: string; instruction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body.action !== "draft") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const mailbox = body.mailbox || "";
  const threadId = body.thread_id || "";
  if (!dealMailboxes().includes(mailbox) || !threadId)
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  return withGmailFeature("email-module", async () => {
    try {
      const raw = await getThreadCapped(mailbox, threadId);
      if (!raw.length) return NextResponse.json({ error: "Thread too large or empty to draft from." }, { status: 413 });
      const msgs = shapeThread(raw);
      const subject = msgs[msgs.length - 1]?.subject || "";
      const draft = await draftReply(subject, msgs, body.instruction || "");
      return NextResponse.json({ ok: true, draft, subject });
    } catch (e) {
      if (isGmailBudgetError(e)) return NextResponse.json({ error: GMAIL_BUDGET_MESSAGE, budgetPaused: true }, { status: 429 });
      return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
    }
  });
}
