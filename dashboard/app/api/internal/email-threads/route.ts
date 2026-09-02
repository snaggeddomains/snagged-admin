// Internal server-to-server endpoint so the research app's Domain Owner CHAT can
// ingest relevant email threads (instead of the user copy-pasting them). Reuses
// the existing Gmail service-account layer (lib/gmail.ts) over the deal mailboxes.
//
// Auth: a shared secret header `x-internal-secret` == RESEARCH_INTERNAL_SECRET
// (NOT the user session — this is called by the research backend). The mailbox
// param is constrained to dealMailboxes() so it can't impersonate an arbitrary
// address. Read-only.
//
//   GET ?q=<query|domain>[&max=N]              -> { threads:[{mailbox,threadId,subject,from,fromName,date,snippet}] }
//   GET ?action=thread&mailbox=<m>&thread_id=  -> { thread:{mailbox,threadId,subject,count,text} }

import { NextResponse, type NextRequest } from "next/server";
import { dealMailboxes, gmailConfigured, searchMessages, getMessage, getThread, getThreadMeta, GMAIL_THREAD_SIZE_CAP } from "@/lib/gmail";
import { withGmailFeature } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authStatus(req: NextRequest): "ok" | "unconfigured" | "mismatch" {
  const secret = process.env.RESEARCH_INTERNAL_SECRET || "";
  if (!secret) return "unconfigured";
  const got = (req.headers.get("x-internal-secret") || "").trim();
  return got === secret.trim() ? "ok" : "mismatch";
}

export async function GET(req: NextRequest) {
  const auth = authStatus(req);
  if (auth === "unconfigured") {
    // The admin project has no RESEARCH_INTERNAL_SECRET at runtime (unset, or set
    // but not yet redeployed). Distinct from a mismatch so it's obvious which side.
    return NextResponse.json({ error: "Server has no RESEARCH_INTERNAL_SECRET configured (set it on snagged-admin and redeploy)." }, { status: 503 });
  }
  if (auth === "mismatch") {
    // Report lengths (NOT the secrets) so a mismatch is debuggable: equal lengths
    // but mismatch => genuinely different values; unequal => a truncated/partial paste.
    const serverLen = (process.env.RESEARCH_INTERNAL_SECRET || "").trim().length;
    const recvLen = (req.headers.get("x-internal-secret") || "").trim().length;
    return NextResponse.json(
      { error: `Secret mismatch (admin has ${serverLen} chars, research sent ${recvLen}) — set RESEARCH_INTERNAL_SECRET to the same value in both projects and redeploy both.` },
      { status: 401 },
    );
  }
  if (!gmailConfigured()) {
    return NextResponse.json({ error: "Gmail not configured" }, { status: 503 });
  }
  const sp = req.nextUrl.searchParams;
  const mailboxes = dealMailboxes();

  try {
    return await withGmailFeature("email-threads", async () => {
    if (sp.get("action") === "thread") {
      const mailbox = (sp.get("mailbox") || "").trim().toLowerCase();
      const threadId = (sp.get("thread_id") || "").trim();
      if (!mailbox || !threadId) return NextResponse.json({ error: "Missing mailbox/thread_id" }, { status: 400 });
      if (!mailboxes.includes(mailbox)) return NextResponse.json({ error: "Unknown mailbox" }, { status: 400 });
      // Skip a giant chain — re-downloading full bodies of a huge thread burns the shared
      // per-user Gmail data quota (which throttles the user's own Superhuman/Gmail). A
      // low-priority attach is never worth that; the requester gets a clear message.
      try {
        const meta = await getThreadMeta(mailbox, threadId);
        if (meta.sizeEstimate > GMAIL_THREAD_SIZE_CAP) {
          return NextResponse.json({ error: `Thread too large to attach (${Math.round(meta.sizeEstimate / 1024 / 1024)} MB across ${meta.count} messages). Attach a more specific thread instead.` }, { status: 413 });
        }
      } catch { /* metadata unavailable — proceed with the normal fetch */ }
      const msgs = await getThread(mailbox, threadId);
      if (!msgs.length) return NextResponse.json({ error: "Thread not found" }, { status: 404 });
      const subject = msgs[0].subject || "(no subject)";
      const text = msgs
        .map((m) => {
          const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
          const when = m.date ? new Date(m.date).toISOString().slice(0, 16).replace("T", " ") : "";
          return `From: ${who}${when ? ` · ${when}` : ""}\nSubject: ${m.subject || subject}\n\n${(m.body || m.snippet || "").trim()}`;
        })
        .join("\n\n———\n\n");
      return NextResponse.json({ thread: { mailbox, threadId, subject, count: msgs.length, text } });
    }

    // Search / auto-suggest. `q` defaults to the domain; Gmail query syntax allowed.
    const q = (sp.get("q") || "").trim();
    if (!q) return NextResponse.json({ error: "Missing q" }, { status: 400 });
    const max = Math.min(Number(sp.get("max")) || 18, 40);

    // First message id per (mailbox, threadId), newest mailboxes scanned in parallel.
    const perMailbox = await Promise.all(
      mailboxes.map(async (mb) => {
        try {
          const stubs = await searchMessages(mb, q, 30);
          const firstByThread = new Map<string, string>();
          for (const s of stubs) if (!firstByThread.has(s.threadId)) firstByThread.set(s.threadId, s.id);
          return [...firstByThread.entries()].map(([threadId, id]) => ({ mailbox: mb, threadId, id }));
        } catch {
          return [];
        }
      }),
    );
    const candidates = perMailbox.flat().slice(0, max);
    const threads = (
      await Promise.all(
        candidates.map(async ({ mailbox, threadId, id }) => {
          try {
            const m = await getMessage(mailbox, id);
            return {
              mailbox, threadId,
              subject: m.subject || "(no subject)",
              from: m.from, fromName: m.fromName,
              date: m.date, snippet: m.snippet || "",
            };
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean) as Array<Record<string, unknown>>;
    threads.sort((a, b) => Number(b.date || 0) - Number(a.date || 0));
    return NextResponse.json({ threads });
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
