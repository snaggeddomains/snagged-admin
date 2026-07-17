// Gmail ingest for the corpus (spec §2.4 / §14). Reads the deal mailboxes via the
// existing read-only Gmail layer (domain-wide delegation, per-mailbox impersonation)
// and harvests (a) the counterparty's domain and (b) domains explicitly mentioned in
// the subject/body — with guardrails so inboxes don't flood the corpus with noise:
//   • skip mass/marketing sends (GmailMessage.bulk)
//   • skip threads addressed to many external recipients
//   • drop free-mail / infra / social / our-own domains (canonical.ts IGNORE set)
//
// Incremental by design: pass a small `days` for the daily run; a large `days` for a
// one-time backfill. The DB accumulates, so old mail need only be scanned once.

import { searchMessages, getMessage } from "../../gmail";
import { extractApexes, canonicalApex, isIgnoredDomain, isBulkSender, cleanClientLabel, isInternalOwner } from "../canonical";
import { isoFromEpoch } from "../merge";
import type { RawHit } from "../types";

const MAILBOXES = (process.env.CORPUS_GMAIL_MAILBOXES || "rob@snagged.com,brian@snagged.com,sam@snagged.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MASS_RECIPIENTS = 10; // a thread to more than this many people is a blast, not a deal
const MAX_PER_MAILBOX = Number(process.env.CORPUS_GMAIL_MAX || 300);

const bareAddrs = (s: string): string[] => (s.match(/[\w.\-+]+@[\w.\-]+/g) || []).map((a) => a.toLowerCase());

function recipientCount(to: string, cc: string): number {
  const set = new Set<string>([...bareAddrs(to), ...bareAddrs(cc)]);
  return set.size;
}

function excerpt(s: string, n = 160): string {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

/** Harvest corpus hits from one mailbox over the trailing `days`. */
async function ingestMailbox(mailbox: string, days: number): Promise<RawHit[]> {
  const q = `newer_than:${days}d -in:chats -in:spam -in:trash`;
  const stubs = await searchMessages(mailbox, q, MAX_PER_MAILBOX);
  const hits: RawHit[] = [];
  for (const stub of stubs) {
    let msg;
    try {
      msg = await getMessage(mailbox, stub.id);
    } catch {
      continue; // one bad message never blocks the run
    }
    if (msg.bulk) continue; // mass/marketing send
    // Marketplace / auction / drop-catch / no-reply blast (NameJet, Catches.io, …) —
    // these are lists of names for sale, NOT client conversations. Skip entirely.
    if (isBulkSender(msg.from)) continue;
    if (recipientCount(msg.to, msg.cc) > MASS_RECIPIENTS) continue; // blast thread
    const date = msg.date ? isoFromEpoch(msg.date) : null;
    // The client is the OTHER party. When WE sent it (rob/brian/sam), the sender name
    // is us — attribute NO client rather than tagging every name "Rob"/"Brian". Never
    // store an email address or junk label as a client.
    const rawName = (msg.fromName || "").trim();
    const contact = isInternalOwner(rawName) ? null : cleanClientLabel(rawName || msg.from);
    const noteBase = `[Gmail:${mailbox}]${date ? ` Date:${date}` : ""}${msg.subject ? ` Subject:"${excerpt(msg.subject, 120)}"` : ""}`;

    // (a) counterparty domain (the sender, when it's an outside party)
    const fromDom = canonicalApex(msg.from);
    if (fromDom && !isIgnoredDomain(fromDom)) {
      hits.push({ domain: fromDom, client: contact, source: `[Gmail:${mailbox}]`, note: `${noteBase} Counterparty`, date });
    }
    // (b) domains explicitly mentioned in subject + body
    for (const domain of extractApexes(`${msg.subject}\n${msg.body}`)) {
      hits.push({ domain, client: contact, source: `[Gmail:${mailbox}]`, note: `${noteBase} ${excerpt(msg.snippet, 120)}`, date });
    }
  }
  return hits;
}

/** Ingest every configured mailbox. Each mailbox is fail-open (one failure doesn't sink the rest). */
export async function readGmailHits(days: number): Promise<RawHit[]> {
  const out: RawHit[] = [];
  for (const mailbox of MAILBOXES) {
    try {
      const hits = await ingestMailbox(mailbox, days);
      out.push(...hits);
    } catch (e) {
      console.error(`[corpus] gmail ${mailbox} failed: ${String((e as Error)?.message || e)}`);
    }
  }
  return out;
}
