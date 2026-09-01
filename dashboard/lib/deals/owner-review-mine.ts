// Owner Review — the acquisition-email miner (Increment 2).
//
// Two capabilities, both reading the deal mailboxes via the admin Gmail SA (lib/gmail.ts):
//   1. resolveNameFromThread(domain, email) — DETERMINISTIC full-name pull: the seller's full
//      name is the display name attached to their address in the From/To/Cc headers
//      ("Marc Hadfield <marc@vital.ai>"). No LLM, cheap; powers the card's "Pull full name" button.
//   2. mineOwnerForDomain(domain, …) — LLM pass over the acquisition thread that determines the
//      SELLER we bought FROM (direction-aware: not the buyer we later sold to, not a broker/escrow/
//      marketplace), with full name + contact + channel + confidence. Powers the bulk backfill over
//      all Master Txns + the "new txn row → new card" cron.

import { dealMailboxes, searchMessages, getMessage, type GmailMessage } from "../gmail";
import { getSheetValues } from "../sheets";
import { upsertCardForDomain } from "./owner-review";
import { getDb, isDbConfigured } from "../supabase";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OWNER_REVIEW_MODEL || process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001";
const CARDS = "owner_review_cards";

const esc = (s: string) => s.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
const clean = (s: string) => (s || "").trim().replace(/^"|"$/g, "");
const splitName = (full: string): { first: string; last: string } => {
  const toks = clean(full).split(/\s+/).filter(Boolean);
  return { first: toks[0] || "", last: toks.slice(1).join(" ") };
};

// The display name attached to `email` anywhere in a message's From/To/Cc headers.
function nameForEmail(msg: GmailMessage, email: string): string {
  const e = email.toLowerCase();
  if (msg.from === e && msg.fromName && !/@/.test(msg.fromName)) return clean(msg.fromName);
  const hay = [msg.to, msg.cc].filter(Boolean).join(", ");
  const m = hay.match(new RegExp(`([^,<>\\n]+?)\\s*<\\s*${esc(e)}\\s*>`, "i"));
  if (m) { const nm = clean(m[1]); if (nm && !/@/.test(nm)) return nm; }
  return "";
}

// DETERMINISTIC: pull the full name for `email` from the deal-mailbox thread headers. Stops at the
// first two-token (First Last) display name; falls back to any single-token name. Fail-open to "".
export async function resolveNameFromThread(domain: string, email: string): Promise<{ full: string; first: string; last: string } | null> {
  const e = (email || "").trim().toLowerCase();
  if (!e || !/@/.test(e)) return null;
  let best = "";
  for (const mb of dealMailboxes()) {
    let stubs: { id: string; threadId: string }[] = [];
    try { stubs = await searchMessages(mb, `from:${e} OR to:${e}`, 6); } catch { continue; }
    for (const s of stubs.slice(0, 6)) {
      let msg: GmailMessage;
      try { msg = await getMessage(mb, s.id); } catch { continue; }
      const nm = nameForEmail(msg, e);
      if (nm) {
        if (nm.split(/\s+/).filter(Boolean).length >= 2) { const { first, last } = splitName(nm); return { full: nm, first, last }; }
        if (!best) best = nm;
      }
    }
    if (best) break;   // one usable single-token name is enough if no full name turns up
  }
  if (!best) return null;
  const { first, last } = splitName(best);
  return { full: best, first, last };
}

// ---- LLM miner ----------------------------------------------------------------

export type MinedOwner = {
  seller_found: boolean;
  first_name: string; last_name: string; email: string; phone: string;
  channel: string;                 // Escrow.com / GoDaddy / Afternic / Direct / DropCatch auction / registration / inbound sale …
  confidence: "high" | "medium" | "low" | "broker" | "none";
  buyer_context: string;           // who we SOLD to / who inquired (never the owner)
  evidence: string;
};

const SYSTEM = `You analyze the email threads around a domain that Snagged (a domain brokerage) ACQUIRED. Your ONE job: identify the OWNER we BOUGHT THE DOMAIN FROM — the SELLER — as of that acquisition.

CRITICAL — direction:
- The SELLER is the party who owned the domain and sold it TO Snagged (rob@/brian@ snagged.com/.co).
- Do NOT return the BUYER we later resold it to, an inbound inquirer, or a colleague at the buyer's company.
- Do NOT return a broker/escrow/marketplace intermediary as the owner (GoDaddy/Afternic broker, Escrow.com agent, a marketplace) — if the real owner is hidden behind one of those, seller_found=false and set channel accordingly.
- If the domain was caught at a DROP AUCTION (DropCatch/NameJet/etc.) or REGISTERED (not bought from an owner), seller_found=false, channel="DropCatch auction" / "registration".

Full name: take the seller's real first + last name from their email display name ("Marc Hadfield <marc@vital.ai>") or signature. A generic role mailbox (privacy@, admin@, domainnetcontact@) has no personal name — leave names blank but keep the email.

Return STRICT JSON only, no prose:
{"seller_found":bool,"first_name":"","last_name":"","email":"","phone":"","channel":"","confidence":"high|medium|low|broker|none","buyer_context":"","evidence":"one short sentence"}
confidence: high = a clearly-identified direct seller; medium = probable; low = a guess worth verifying; broker = bought via a broker/marketplace (no real owner surfaced); none = auction/registration/only-the-buyer-in-email.`;

function transcript(domain: string, msgs: GmailMessage[]): string {
  const lines = msgs
    .sort((a, b) => a.date - b.date)
    .slice(0, 14)
    .map((m) => {
      const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
      const body = (m.body || m.snippet || "").replace(/\s+/g, " ").trim().slice(0, 320);
      return `— ${new Date(m.date).toISOString().slice(0, 10)} FROM ${who} TO ${clean(m.to).slice(0, 80)}\n  ${body}`;
    });
  return `DOMAIN: ${domain}\n\nTHREAD (oldest first):\n${lines.join("\n")}`;
}

// Gather the acquisition-relevant messages for a domain across the deal mailboxes (deduped by mid).
async function gatherMessages(domain: string, perMailbox = 8): Promise<GmailMessage[]> {
  const seen = new Set<string>();
  const out: GmailMessage[] = [];
  for (const mb of dealMailboxes()) {
    let stubs: { id: string; threadId: string }[] = [];
    try { stubs = await searchMessages(mb, `"${domain}"`, perMailbox); } catch { continue; }
    for (const s of stubs.slice(0, perMailbox)) {
      try {
        const m = await getMessage(mb, s.id);
        const key = m.mid || m.id;
        if (seen.has(key) || m.bulk) continue;   // skip dup + mass/marketing sends
        seen.add(key);
        out.push(m);
      } catch { /* skip */ }
    }
  }
  return out;
}

// LLM: determine the seller we bought `domain` from. Fail-open to a null-ish "none" result.
export async function mineOwnerForDomain(domain: string, env: NodeJS.ProcessEnv = process.env): Promise<MinedOwner> {
  const empty: MinedOwner = { seller_found: false, first_name: "", last_name: "", email: "", phone: "", channel: "", confidence: "none", buyer_context: "", evidence: "" };
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return empty;
  const msgs = await gatherMessages(domain);
  if (!msgs.length) return { ...empty, evidence: "No acquisition thread found in the deal mailboxes." };
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system: SYSTEM, messages: [{ role: "user", content: transcript(domain, msgs).slice(0, 12000) }] }),
    });
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<MinedOwner>;
    const out: MinedOwner = {
      seller_found: !!j.seller_found,
      first_name: clean(String(j.first_name || "")),
      last_name: clean(String(j.last_name || "")),
      email: clean(String(j.email || "")).toLowerCase(),
      phone: clean(String(j.phone || "")),
      channel: clean(String(j.channel || "")),
      confidence: (["high", "medium", "low", "broker", "none"].includes(String(j.confidence)) ? j.confidence : "none") as MinedOwner["confidence"],
      buyer_context: clean(String(j.buyer_context || "")),
      evidence: clean(String(j.evidence || "")),
    };
    // Deterministic backstop: if we have the seller's email but the LLM didn't give a last name,
    // pull the full name straight from the thread headers (the same path as the "⤓ Pull full name"
    // button) — so every auto-created card carries first+last without anyone clicking.
    if (out.email && !out.last_name) {
      const hit = await resolveNameFromThread(domain, out.email).catch(() => null);
      if (hit && hit.last) { out.first_name = out.first_name || hit.first; out.last_name = hit.last; }
    }
    return out;
  } catch { return empty; }
}

// Read the Master Txns List → [{domain, date, price}] (newest last in the sheet). Column auto-detect:
// domain = the most domain-shaped column; price = the most money-dense column; date = a date-shaped one.
async function readMasterTxns(): Promise<{ domain: string; date: string; price: string }[]> {
  const sheetId = process.env.SNAGGED_TRACKER_SHEET_ID || "1TVAJ2ef_rM03pHZ9rq8C3W4BgyiSBiOc5j7jAbFzGTA";
  const range = process.env.SNAGGED_TXNS_RANGE || "'Master Txns List'!A1:Z20000";
  const rows = await getSheetValues(sheetId, range);
  if (!rows.length) return [];
  const body = rows.slice(1);
  const ncol = Math.max(...rows.map((r) => r.length));
  const domainRe = /^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/i;
  const moneyRe = /\$|,\d{3}|^\d{3,}$/;
  const dateRe = /\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}/;
  const score = (col: number, re: RegExp) => body.reduce((n, r) => n + (re.test(String(r[col] || "").trim()) ? 1 : 0), 0);
  let dCol = 0, pCol = 1, tCol = -1, dBest = -1, pBest = -1, tBest = -1;
  for (let c = 0; c < ncol; c++) {
    const d = body.reduce((n, r) => n + (domainRe.test(String(r[c] || "").trim()) ? 1 : 0), 0);
    if (d > dBest) { dBest = d; dCol = c; }
    const p = score(c, moneyRe); if (p > pBest && c !== dCol) { pBest = p; pCol = c; }
    const t = score(c, dateRe); if (t > tBest) { tBest = t; tCol = c; }
  }
  const out: { domain: string; date: string; price: string }[] = [];
  for (const r of body) {
    const domain = String(r[dCol] || "").trim().toLowerCase();
    if (!domainRe.test(domain)) continue;
    out.push({ domain, date: tCol >= 0 ? String(r[tCol] || "").trim() : "", price: String(r[pCol] || "").trim() });
  }
  return out;
}

export type MineSummary = { scanned: number; created: number; existing: number; skipped: number; total?: number; remaining?: number; note?: string; results: { domain: string; created: boolean; confidence: string; name: string }[] };

// Bulk backfill: mine every Master Txn that doesn't already have a card, newest first. `dry` skips
// writes. `limit` bounds a run (Gmail quota + the 300s route budget). Idempotent per domain.
export async function mineAllTxns(opts: { limit?: number; dry?: boolean } = {}): Promise<MineSummary> {
  const limit = opts.limit ?? 40;
  const dry = !!opts.dry;
  const sum: MineSummary = { scanned: 0, created: 0, existing: 0, skipped: 0, results: [] };
  if (!isDbConfigured()) return { ...sum, note: "DB not configured" };
  // HARD GUARD: without the LLM key the miner can't determine the seller/direction, so it would
  // create empty "none" cards for the whole backlog. Refuse rather than flood the queue.
  if (!process.env.ANTHROPIC_API_KEY) return { ...sum, note: "ANTHROPIC_API_KEY not set on the admin project — the miner needs it to read the seller from each thread. Set it, then run again." };
  const txns = (await readMasterTxns()).reverse();   // newest first
  sum.total = txns.length;
  for (const t of txns) {
    if (sum.created + sum.skipped >= limit) break;
    if (await getCard2ByDomain(t.domain)) { sum.existing++; continue; }
    sum.scanned++;
    const mined = await mineOwnerForDomain(t.domain);
    const name = [mined.first_name, mined.last_name].filter(Boolean).join(" ");
    if (dry) { sum.results.push({ domain: t.domain, created: false, confidence: mined.confidence, name }); continue; }
    const card = await upsertCardForDomain({
      domain: t.domain, txn_date: t.date, txn_price: t.price,
      candidate_name: name || null, candidate_first_name: mined.first_name || null, candidate_last_name: mined.last_name || null,
      candidate_email: mined.email || null, candidate_phone: mined.phone || null,
      channel: mined.channel || null, buyer_context: mined.buyer_context || null,
      confidence: mined.confidence, evidence: mined.evidence || null, source: "txn",
    });
    if (card) { sum.created++; sum.results.push({ domain: t.domain, created: true, confidence: mined.confidence, name }); }
    else sum.skipped++;
  }
  // Rough remaining = txns with no card yet after this batch (existing counted only those hit before
  // the limit, so recompute against the total for an accurate "more to go").
  sum.remaining = Math.max(0, (sum.total || 0) - sum.existing - sum.created);
  return sum;
}

// Cheap existence check by domain (the miner shouldn't re-mine a domain that already has a card).
async function getCard2ByDomain(domain: string): Promise<boolean> {
  try {
    const { data } = await getDb().from(CARDS).select("id").eq("domain", domain.toLowerCase()).limit(1).maybeSingle();
    return !!data;
  } catch { return false; }
}
