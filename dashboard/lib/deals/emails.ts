// Per-deal email ingestion. Finds the Gmail threads relevant to a deal (the buyer's
// address / company domain / the target domain), then expands each matched thread to
// store EVERY message (one deal_emails row per email — the full back-and-forth, like
// Pipedrive — not just the latest per thread). Best-effort: no Gmail config / no matches
// → 0, never throws to the caller.

import { dealMailboxes, gmailConfigured, searchMessages, getThread } from "../gmail";
import { replaceDealEmails, type Deal } from "./store";

const MAX_PER_MAILBOX = 40; // matched stubs pulled per mailbox
const MAX_THREADS = 25;     // threads expanded per deal
const MAX_ROWS = 150;       // total messages stored per deal (cap a huge thread)

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

// Free-email providers — for these, only the exact buyer address is a safe match
// (matching the whole domain would pull every gmail.com thread). For a real company
// domain we DO match the whole domain, so a colleague on the buyer's side (e.g. the
// inquiry came from kara@ but the negotiation runs through mallory@) is still caught.
const FREE_EMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.com", "mail.com", "pm.me",
]);

// Build the Gmail query for a deal. Three tied signals, OR'd together:
//   1. the BUYER's exact address (the inbound inquiry contact),
//   2. anyone at the buyer's COMPANY email-domain (colleagues on the deal side) —
//      skipped for free-email providers (matching all of gmail.com is useless),
//   3. the TARGET DOMAIN NAME itself (e.g. tealhealth.com) — catches the initial
//      inbound submission + internal threads that reference the name.
// The noise this used to pull (marketplace alerts, our own "deal assigned" emails)
// is stripped by the query excludes below AND the isNoise() sender/subject check.
function queryFor(deal: Deal): string | null {
  const buyer = deal.buyer_email?.trim().toLowerCase();
  const parts: string[] = [];
  if (buyer) {
    parts.push(`from:${buyer}`, `to:${buyer}`, `cc:${buyer}`);
    const dom = buyer.split("@")[1];
    if (dom && !FREE_EMAIL.has(dom)) parts.push(`from:${dom}`, `to:${dom}`, `cc:${dom}`);
  }
  if (deal.domain) parts.push(`"${deal.domain}"`); // the target name itself
  if (!parts.length) return null;
  const exclude = "-from:namejet -from:noreply -from:no-reply -from:reports@snagged.com -from:notifications";
  return `{${parts.join(" ")}} ${exclude} -in:chats -in:spam -in:trash newer_than:730d`;
}

export async function ingestDealEmails(deal: Deal): Promise<number> {
  if (!gmailConfigured()) return 0;
  const q = queryFor(deal);
  if (!q) return 0;

  // msg-id → one row per email (RFC Message-ID dedupes the same message across mailboxes).
  const byMsg = new Map<string, { mailbox: string; thread_id: string; msg_id: string; subject: string | null; snippet: string | null; body: string | null; from_addr: string | null; msg_date: string | null }>();
  const seenThreads = new Set<string>();

  for (const mailbox of dealMailboxes()) {
    if (byMsg.size >= MAX_ROWS) break;
    let stubs: { id: string; threadId: string }[] = [];
    try { stubs = await searchMessages(mailbox, q, MAX_PER_MAILBOX); } catch { continue; }
    // Unique matched threads in this mailbox — expand each to the FULL conversation.
    const threads: string[] = [];
    for (const s of stubs) {
      const k = `${mailbox}::${s.threadId}`;
      if (!seenThreads.has(k)) { seenThreads.add(k); threads.push(s.threadId); }
    }
    for (const threadId of threads.slice(0, MAX_THREADS)) {
      if (byMsg.size >= MAX_ROWS) break;
      let msgs;
      try { msgs = await getThread(mailbox, threadId); } catch { continue; }
      for (const msg of msgs) {
        if (isNoise(msg.from || null, msg.subject || null)) continue; // drop system/alert noise
        const key = msg.mid || `${mailbox}:${msg.id}`;
        if (byMsg.has(key)) continue; // same RFC message already captured (other mailbox)
        byMsg.set(key, {
          mailbox, thread_id: msg.threadId, msg_id: key,
          subject: msg.subject || null, snippet: msg.snippet || null,
          body: (msg.body || "").slice(0, 8000) || null, from_addr: msg.from || null,
          msg_date: isoOrNull(msg.date),
        });
        if (byMsg.size >= MAX_ROWS) break;
      }
    }
  }
  const rows = [...byMsg.values()];
  if (!rows.length) return 0;
  try { return await replaceDealEmails(deal.id, rows); } catch { return 0; }
}
