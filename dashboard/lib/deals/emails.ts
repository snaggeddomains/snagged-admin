// Per-deal email ingestion. Pulls the Gmail threads relevant to a deal (the buyer's
// address and/or the target domain) from the deal mailboxes via the existing read-only
// Gmail layer, dedupes to one row per thread (latest message), and upserts deal_emails.
// Best-effort: no Gmail config / no matches → 0, never throws to the caller.

import { dealMailboxes, gmailConfigured, searchMessages, getMessage } from "../gmail";
import { upsertDealEmails, type Deal } from "./store";

const MAX_PER_MAILBOX = 40;

function isoOrNull(epoch: number): string | null {
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
}

// Build the Gmail query for a deal: mail to/from the buyer, or mentioning the domain.
function queryFor(deal: Deal): string | null {
  const parts: string[] = [];
  if (deal.buyer_email) parts.push(`from:${deal.buyer_email}`, `to:${deal.buyer_email}`);
  if (deal.domain) parts.push(`"${deal.domain}"`);
  if (!parts.length) return null;
  return `{${parts.join(" ")}} -in:chats -in:spam -in:trash newer_than:730d`;
}

export async function ingestDealEmails(deal: Deal): Promise<number> {
  if (!gmailConfigured()) return 0;
  const q = queryFor(deal);
  if (!q) return 0;

  // threadId → the newest message we've seen for it (subject/snippet/date/from).
  const byThread = new Map<string, { mailbox: string; thread_id: string; subject: string | null; snippet: string | null; body: string | null; from_addr: string | null; msg_date: string | null; epoch: number }>();

  for (const mailbox of dealMailboxes()) {
    let stubs: { id: string; threadId: string }[] = [];
    try { stubs = await searchMessages(mailbox, q, MAX_PER_MAILBOX); } catch { continue; }
    for (const stub of stubs) {
      let msg;
      try { msg = await getMessage(mailbox, stub.id); } catch { continue; }
      const prev = byThread.get(msg.threadId);
      if (prev && prev.epoch >= (msg.date || 0)) continue; // keep the newest per thread
      byThread.set(msg.threadId, {
        mailbox, thread_id: msg.threadId,
        subject: msg.subject || null, snippet: msg.snippet || null,
        body: (msg.body || "").slice(0, 8000) || null, from_addr: msg.from || null,
        msg_date: isoOrNull(msg.date), epoch: msg.date || 0,
      });
    }
  }
  const rows = [...byThread.values()].map(({ epoch: _epoch, ...r }) => r);
  if (!rows.length) return 0;
  try { return await upsertDealEmails(deal.id, rows); } catch { return 0; }
}
