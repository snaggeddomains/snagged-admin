// Per-deal email ingestion. Finds the Gmail threads relevant to a deal (the buyer's
// address / company domain / the target domain), then expands each matched thread to
// store EVERY message (one deal_emails row per email — the full back-and-forth, like
// Pipedrive — not just the latest per thread). Best-effort: no Gmail config / no matches
// → 0, never throws to the caller.

import { dealMailboxes, gmailConfigured, searchMessages, getThread, getThreadMeta } from "../gmail";
import { replaceDealEmails, listDealEmails, type Deal, type DealEmail } from "./store";

// Never RE-download a thread bigger than this (bodies + attachments) — a few giant negotiation
// threads re-pulled every run were burning the shared per-user Gmail data quota (Superhuman was
// hitting the same wall: one 145 MB thread re-downloaded 355×). We keep whatever we already have
// for such a thread and skip the re-fetch. A brand-new thread is still ingested once. Env-tunable.
const THREAD_SIZE_CAP = Number(process.env.DEAL_EMAIL_THREAD_MAX_BYTES) || 10 * 1024 * 1024;

const MAX_PER_MAILBOX = 40; // matched stubs pulled per mailbox
const MAX_THREADS = 25;     // threads expanded per deal
const MAX_ROWS = 150;       // total messages stored per deal (cap a huge thread)

function isoOrNull(epoch: number): string | null {
  return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
}

// Senders that are never a real buyer conversation: our own system notifications
// (the "new deal assigned" email), registrar/marketplace alerts (NameJet, drop
// catchers), domain-monitoring services (DomainScout), and generic no-reply bots.
// Matched against the From address.
const NOISE_FROM = /(^|[@.])(namejet|dropcatch|namebright|godaddy|afternic|sedo|dan\.com|dynadot|namesilo|namecheap|domainscout)\.|reports@snagged\.com|no-?reply|do-?not-?reply|notifications?@|mailer-daemon|postmaster@/i;
// Our own outbound notification subjects + monitoring-alert subjects (belt-and-suspenders
// with the sender + body filters). "<domain> has been updated." is DomainScout's format.
const NOISE_SUBJECT = /new buy-side deal|deal assigned|namejet alert|domain (alert|backorder)|name ?check|has been updated\.?\s*$/i;
// Transactional/monitoring BODY markers — a real negotiation never contains these. Catches
// DomainScout "…has been updated. The EPP Status Codes have been changed from […] to […]"
// and similar WHOIS/nameserver change notifications, regardless of who the sender shows as.
const NOISE_BODY = /domainscout|epp status codes?|status codes? (?:have|has) been changed|(?:whois record|nameservers?) .{0,40}(?:changed|updated)/i;

function isNoise(from: string | null, subject: string | null, body: string | null): boolean {
  return NOISE_FROM.test(from || "") || NOISE_SUBJECT.test(subject || "") || NOISE_BODY.test(body || "");
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

  // What we already have (per thread) — so a skipped re-download carries its rows forward
  // (replaceDealEmails deletes-and-replaces) and the "unchanged" check has a baseline.
  const existing = await listDealEmails(deal.id).catch(() => [] as DealEmail[]);
  const existingByThread = new Map<string, DealEmail[]>();
  const storedMids = new Map<string, Set<string>>();
  for (const e of existing) {
    if (!e.thread_id || !e.msg_id) continue;
    (existingByThread.get(e.thread_id) || existingByThread.set(e.thread_id, []).get(e.thread_id)!).push(e);
    (storedMids.get(e.thread_id) || storedMids.set(e.thread_id, new Set()).get(e.thread_id)!).add(e.msg_id);
  }
  const carryThread = (threadId: string) => {
    for (const e of existingByThread.get(threadId) || []) {
      if (e.msg_id && !byMsg.has(e.msg_id)) byMsg.set(e.msg_id, { mailbox: e.mailbox || "", thread_id: e.thread_id, msg_id: e.msg_id, subject: e.subject, snippet: e.snippet, body: e.body, from_addr: e.from_addr, msg_date: e.msg_date });
    }
  };

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
      // Cheap metadata pre-check — avoid the heavy full download when we ALREADY have the thread
      // and it's either oversized (never re-pull a giant thread) or unchanged (newest message
      // already stored). A brand-new thread falls through and is ingested once.
      const alreadyHave = (existingByThread.get(threadId)?.length || 0) > 0;
      if (alreadyHave) {
        let meta = null as Awaited<ReturnType<typeof getThreadMeta>> | null;
        try { meta = await getThreadMeta(mailbox, threadId); } catch { meta = null; }
        if (meta) {
          if (meta.sizeEstimate > THREAD_SIZE_CAP) { carryThread(threadId); continue; }        // don't re-download a giant thread
          if (meta.newestMid && storedMids.get(threadId)?.has(meta.newestMid)) { carryThread(threadId); continue; } // unchanged
        }
      }
      let msgs;
      try { msgs = await getThread(mailbox, threadId); } catch { carryThread(threadId); continue; }
      for (const msg of msgs) {
        // drop system/alert noise — check body/snippet too (DomainScout etc. can show as "rob → rob")
        if (isNoise(msg.from || null, msg.subject || null, `${msg.snippet || ""} ${msg.body || ""}`)) continue;
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
