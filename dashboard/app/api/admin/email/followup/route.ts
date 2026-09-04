// Email → Follow-up tool. After a "should we work together?" call, draft the follow-up email from
// (1) the most recent Gmail thread with the prospect, (2) the Granola meeting notes for that call,
// and (3) a free-text steer with the terms (e.g. "10% success fee, no upfront"). DRAFT-ONLY.
//
// Thread search/load is reused from the Email module (/api/admin/email ?action=search|thread). This
// route adds: GET ?action=notes (list recent Granola meetings, auto-matched to the thread's
// counterparty by attendee email) and POST {action:'draft'} (the follow-up draft). Gated by `email`.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { dealMailboxes, getThreadCapped, gmailConfigured, type GmailMessage } from "@/lib/gmail";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";
import { granolaConfigured, listNotes, getNote } from "@/lib/granola";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL =
  process.env.EMAIL_ASSIST_MODEL ||
  process.env.OUTREACH_MODEL ||
  process.env.DEAL_RECAP_MODEL ||
  "claude-haiku-4-5-20251001";

// A thread's messages, oldest-first, trimmed. (Small duplicate of the Email module's shaper — kept
// local so this route is self-contained; the shapes must match what the client already renders.)
function shapeThread(msgs: GmailMessage[]) {
  return msgs
    .slice()
    .sort((a, b) => a.date - b.date)
    .map((m) => ({ from: m.from, fromName: m.fromName, to: m.to, date: m.date, subject: m.subject, body: (m.body || m.snippet || "").slice(0, 6000) }));
}
function threadTranscript(subject: string, msgs: ReturnType<typeof shapeThread>): string {
  const lines = msgs.map((m) => {
    const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
    const body = (m.body || "").replace(/\s+/g, " ").trim().slice(0, 1500);
    return `--- ${new Date(m.date).toISOString().slice(0, 10)} FROM ${who} TO ${(m.to || "").slice(0, 120)}\n${body}`;
  });
  return `SUBJECT: ${subject}\n\n${lines.join("\n\n")}`;
}

const SYSTEM = `You are the founder/broker at Snagged (a domain brokerage) writing a FOLLOW-UP email after a "should we work together?" call with a prospective client. You write in Snagged's voice: warm but direct, concise, confident, never pushy or salesy. No emdashes. No hype.

You are given: the prior EMAIL THREAD with the prospect, the MEETING NOTES from the call (an AI summary and possibly a transcript), and a FOLLOW-UP BRIEF with the specifics of what to propose (terms, next steps, tone).

Rules:
- Ground the email in what was ACTUALLY discussed — reference concrete points from the meeting notes and the thread (their goal, the names/domains discussed, a concern they raised). A generic "great to connect" note is a FAILURE.
- Work in the exact terms from the FOLLOW-UP BRIEF naturally (e.g. "10% success fee, nothing upfront"). If the brief gives a figure or structure, state it clearly.
- Reference the meeting only as far as the notes support it. Never invent commitments, numbers, names, or claims not in the notes/thread/brief.
- Address the person by name if it's clear from the thread or attendees; otherwise a neutral greeting.
- Keep it tight — a few short paragraphs. End with ONE clear next step.
- Return ONLY the email body text, ready to copy/paste. No subject line unless the brief asks. No preamble, no markdown fences, no quotes. Sign off simply ("[Your name]" if the sender's name isn't obvious).`;

async function callAnthropic(user: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Drafting is not configured (ANTHROPIC_API_KEY unset).");
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 1100, system: SYSTEM, messages: [{ role: "user", content: user }] }),
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

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "notes";
  if (action !== "notes") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (!granolaConfigured())
    return NextResponse.json({ error: "Granola is not connected (set GRANOLA_API_KEY).", notes: [] }, { status: 503 });

  // Auto-match: emails from the thread's counterparty (comma-separated) — a note whose attendees
  // include one of them is floated to the top and flagged.
  const match = new Set(
    (url.searchParams.get("match") || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes("@")),
  );
  const notes = await listNotes({ limit: 40 });
  const shaped = notes.map((n) => {
    const matched = match.size > 0 && n.attendees.some((a) => a.email && match.has(a.email));
    return {
      id: n.id,
      title: n.title,
      createdAt: n.createdAt,
      attendees: n.attendees.map((a) => a.name || a.email).filter(Boolean).slice(0, 8),
      matched,
    };
  });
  shaped.sort((a, b) => (a.matched === b.matched ? b.createdAt - a.createdAt : a.matched ? -1 : 1));
  return NextResponse.json({ ok: true, notes: shaped });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });

  let body: { action?: string; mailbox?: string; thread_id?: string; note_id?: string; instruction?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body.action !== "draft") return NextResponse.json({ error: "Unknown action" }, { status: 400 });

  const instruction = (body.instruction || "").trim();
  const mailbox = body.mailbox || "";
  const threadId = body.thread_id || "";
  const noteId = body.note_id || "";
  // Need SOMETHING to draft from: a thread, a meeting, or at least the brief.
  if (!threadId && !noteId && !instruction)
    return NextResponse.json({ error: "Pick a thread or a meeting, or add a brief." }, { status: 400 });
  if (threadId && (!gmailConfigured() || !dealMailboxes().includes(mailbox)))
    return NextResponse.json({ error: "Bad request" }, { status: 400 });

  try {
    // Meeting notes (Granola) — best-effort; pull the summary + transcript for context.
    let meetingBlock = "";
    if (noteId) {
      const note = await getNote(noteId, { transcript: true });
      if (note) {
        const attns = note.attendees.map((a) => (a.email ? `${a.name || ""} <${a.email}>`.trim() : a.name)).filter(Boolean).join(", ");
        meetingBlock =
          `MEETING NOTES — ${note.title}${note.createdAt ? ` (${new Date(note.createdAt).toISOString().slice(0, 10)})` : ""}\n` +
          (attns ? `Attendees: ${attns}\n` : "") +
          (note.summary ? `\nSummary:\n${note.summary.slice(0, 6000)}\n` : "") +
          (note.transcript ? `\nTranscript (excerpt):\n${note.transcript.slice(0, 6000)}\n` : "");
      }
    }

    // Prior email thread (Gmail) — governed; skips/loud-fails under the budget breaker.
    let threadBlock = "";
    if (threadId) {
      threadBlock = await withGmailFeature("email-module", async () => {
        const raw = await getThreadCapped(mailbox, threadId);
        if (!raw.length) return "";
        const msgs = shapeThread(raw);
        const subject = msgs[msgs.length - 1]?.subject || "";
        return `EMAIL THREAD (oldest first):\n\n${threadTranscript(subject, msgs).slice(0, 12000)}`;
      });
    }

    const parts = [
      threadBlock,
      meetingBlock,
      `FOLLOW-UP BRIEF:\n${instruction || "Write a warm, specific follow-up that recaps the call, proposes working together, and asks for a clear next step."}`,
    ].filter(Boolean);
    const draft = await callAnthropic(parts.join("\n\n").slice(0, 24000));
    return NextResponse.json({ ok: true, draft });
  } catch (e) {
    if (isGmailBudgetError(e)) return NextResponse.json({ error: GMAIL_BUDGET_MESSAGE, budgetPaused: true }, { status: 429 });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
