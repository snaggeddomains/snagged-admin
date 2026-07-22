// Per-deal email ingestion. Pulls the Gmail threads relevant to a deal (the buyer's
// address and/or the target domain) from the deal mailboxes via the existing read-only
// Gmail layer, dedupes to one row per thread (latest message), and upserts deal_emails.
// Best-effort: no Gmail config / no matches → 0, never throws to the caller.

import { dealMailboxes, gmailConfigured, searchMessages, getMessage } from "../gmail";
import { replaceDealEmails, type Deal } from "./store";

const MAX_PER_MAILBOX = 40;

function isoOrNull(epoch: number): string | null {
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
}

// Senders that are never a real buyer conversation: our own system notifications
// (the "new deal assigned" email), registrar/marketplace alerts (NameJet, drop
// catchers), and generic no-reply bots. Matched against the From address.
const NOISE_FROM = /(^|[@.])(namejet|dropcatch|namebright|godaddy|afternic|sedo|dan\.com|dynadot|namesilo|namecheap)\.|reports@snagged\.com|no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster@/i;
// Our own outbound notification subjects (belt-and-suspenders with the sender filter).
const NOISE_SUBJECT = /new buy-side deal|deal assigned|namejet alert|domain (alert|backorder)|name ?check/i;

function isNoise(from: string | null, subject: string | null): boolean {
  return NOISE_FROM.test(from || "") || NOISE_SUBJECT.test(subject || "");
}

// Build the Gmail query for a deal. The buyer's address is the reliable tie to THIS
// deal — a bare domain match pulls in unrelated threads (year-old deals for the same
// name, marketplace alerts, our own notification emails), so we key on the buyer and
// only fall back to the domain when there's no buyer on file. Known noise senders are
// excluded in the query AND re-checked in code below.
function queryFor(deal: Deal): string | null {
  const buyer = deal.buyer_email?.trim();
  const parts: string[] = [];
  if (buyer) parts.push(`from:${buyer}`, `to:${buyer}`, `cc:${buyer}`);
  else if (deal.domain) parts.push(`"${deal.domain}"`);
  if (!parts.length) return null;
  const exclude = "-from:namejet -from:noreply -from:no-reply -from:reports@snagged.com -from:notifications";
  return `{${parts.join(" ")}} ${exclude} -in:chats -in:spam -in:trash newer_than:730d`;
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
      if (isNoise(msg.from || null, msg.subject || null)) continue; // drop system/alert noise
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
  try { return await replaceDealEmails(deal.id, rows); } catch { return 0; }
}
