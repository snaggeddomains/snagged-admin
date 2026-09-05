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

import { dealMailboxes, searchMessages, getMessage, getThreadCapped, type GmailMessage } from "../gmail-mirror";
import { getSheetValues } from "../sheets";
import { upsertCardForDomain } from "./owner-review";
import { getDb, isDbConfigured } from "../supabase";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.OWNER_REVIEW_MODEL || process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001";
const CARDS = "owner_review_cards";

// Automated monitoring / bot senders that NEVER name an owner — DomainScout EPP-status alerts,
// mailer-daemons, no-reply notifications. Dropped from the transcript so they can't crowd out (or
// mislead) the seller read. (DomainScout emails show as rob→rob "…has been updated. The EPP Status
// Codes have been changed…", so a sender-only filter needs the subject/body cues too.)
const NOISE_FROM = /@domainscout\.|domainscout\.io|@domainiq\.|domainiq\.com|mailer-daemon|postmaster@|(^|[._-])no-?reply|do-?not-?reply|notifications?@/i;
const NOISE_SUBJECT = /epp status code|status codes? (have )?been changed|has been updated\b|new monitoring alert|monitoring alerts? for\b|domainiq:/i;
function isNoiseMsg(m: GmailMessage): boolean {
  return NOISE_FROM.test(m.from || "") || NOISE_SUBJECT.test(m.subject || "");
}

// Mailboxes the miner reads. brian@ is now BACK IN by default (2026-09-04): the miner reads through
// lib/gmail-mirror in strict local-only mode, so it NEVER pulls from Gmail — reading brian's mailbox
// hits only the local Postgres copy (or returns empty for a not-yet-mirrored box), zero throttle risk.
// (He was excluded while the miner still hit Gmail directly.) Override with OWNER_REVIEW_SKIP_MAILBOXES
// (comma list) to skip a mailbox again; default = skip none.
function minerMailboxes(): string[] {
  const raw = process.env.OWNER_REVIEW_SKIP_MAILBOXES;
  const skip = (raw != null ? raw : "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return dealMailboxes().filter((mb) => !skip.includes(mb.toLowerCase()));
}

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
  for (const mb of minerMailboxes()) {
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

const SYSTEM = `You analyze the email threads around a domain that Snagged (a domain brokerage) ACQUIRED. Your ONE job: identify the SELLER-SIDE POINT OF CONTACT for that acquisition — the person we (Snagged: rob@/brian@ snagged.com/.co) negotiated with to BUY the domain, so we know WHO TO CONTACT about this name.

WHAT TO RETURN (in order of preference, but ANY of these is a valid answer — don't hold out for the "real" owner):
- The OWNER themselves if they corresponded directly (quotes their own price, reveals a personal stake, replies from a real personal/company address).
- OTHERWISE the SELLER'S BROKER / AGENT / REP — a named human who negotiated the sale ON THE SELLER'S BEHALF (e.g. "Kara <caymanbusinessweb@gmail.com>" relaying for the owner, "Nick <nnelson@trmnl.com>" at the selling company). Recording the broker/rep's contact IS the right outcome — the point is who to reach out to, not who ultimately held title. Set channel to note they're a broker/rep (e.g. "via broker Kara").
- Capture their real name + email + phone from the display name / signature / thread.

Do NOT return:
- The BUYER we later resold to, an inbound inquirer, or the buyer's colleagues (e.g. ryan@usetrmnl.com when usetrmnl is the buyer).
- Our OWN people (snagged.com/.co).
- A pure transaction-processor with NO negotiating role: an Escrow.com/Escrow-Domains agent handling only paperwork, or a marketplace PLATFORM notification bot. (A named human broker who actually negotiated is NOT this — record them.)

seller_found=false ONLY when there is genuinely NO human counterparty to contact: a DROP AUCTION (DropCatch/NameJet), a plain REGISTRATION, or a marketplace purchase where no person ever corresponded — set channel="DropCatch auction"/"registration"/"marketplace" accordingly.

Look across ALL the threads below, not just the first — the seller-side negotiation is often in a SEPARATE, OLDER thread than the escrow/closing/buyer threads. Do not stop at the escrow thread.
A privacy-relay address (…@digitalprivacy.co, whoisguard) a real person replies through is still that person — capture the real name+address they reply as.
Full name: take first + last from the display name ("Nick Nelson <nnelson@trmnl.com>") or signature; a generic role mailbox (privacy@, admin@) has no personal name — leave names blank, keep the email.

Return STRICT JSON only, no prose:
{"seller_found":bool,"first_name":"","last_name":"","email":"","phone":"","channel":"","confidence":"high|medium|low|broker|none","buyer_context":"","evidence":"one short sentence"}
confidence: high = a clearly-identified seller-side contact (owner OR their named broker/rep); medium = probable; low = a guess worth verifying; broker = a broker/rep IS the recorded contact but the ultimate owner stayed hidden (still seller_found=true with their contact); none = no human counterparty at all (auction/registration/only-the-buyer-in-email).`;

// Group the transcript BY THREAD (each thread's own oldest-first run), so the model sees the escrow
// thread AND the direct-owner thread as distinct conversations rather than one date-merged blur.
function transcript(domain: string, msgs: GmailMessage[]): string {
  const byThread = new Map<string, GmailMessage[]>();
  for (const m of msgs) { const k = m.threadId || m.id; (byThread.get(k) || byThread.set(k, []).get(k)!).push(m); }
  // Order threads by their earliest message (oldest conversation first).
  const threads = [...byThread.values()].sort((a, b) => Math.min(...a.map((m) => m.date)) - Math.min(...b.map((m) => m.date)));
  const blocks = threads.map((t, i) => {
    const lines = t.sort((a, b) => a.date - b.date).map((m) => {
      const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from;
      const body = (m.body || m.snippet || "").replace(/\s+/g, " ").trim().slice(0, 400);
      return `  · ${new Date(m.date).toISOString().slice(0, 10)} FROM ${who} TO ${clean(m.to).slice(0, 90)}\n    ${body}`;
    });
    return `THREAD ${i + 1} — "${clean(t[0]?.subject || "").slice(0, 90)}"\n${lines.join("\n")}`;
  });
  return `DOMAIN: ${domain}\n\n${blocks.join("\n\n")}`;
}

// Gather the acquisition-relevant messages for a domain by WHOLE THREADS across the deal mailboxes.
// Reading whole threads (not the first N individual messages) is what surfaces the actual owner: a
// buy often has a noisy escrow/broker thread AND a separate direct thread with the real seller, and a
// flat "first 10 messages" read gets swamped by the escrow one. Per-thread cap keeps a busy thread
// from crowding out the owner thread; getThreadCapped is quota-safe (skips a giant chain). Deduped by
// RFC Message-ID across threads/mailboxes.
async function gatherMessages(domain: string, opts: { maxThreads?: number; perThread?: number } = {}): Promise<GmailMessage[]> {
  const maxThreads = opts.maxThreads ?? 10;
  const perThread = opts.perThread ?? 8;
  // 1. CANDIDATE threads mentioning the domain, across the deal mailboxes. SUBJECT match FIRST: the real
  //    acquisition threads name the domain in the subject ("Cerebro.ai inquiry", "Purchase of X",
  //    "Wire complete … X"), whereas recurring monitoring-alert emails (DomainIQ/DomainScout) mention
  //    the domain only in their BODY — so a body-only search, ordered newest-first, gets swamped by
  //    years of alerts. Subject hits first, then a noise-excluded BODY-fill. We over-collect a POOL
  //    (candCap) so all-noise threads (Google-Drive shares, escrow bots) can be dropped without wasting
  //    a real slot — the seller-side negotiation is often an OLDER thread behind the closing/buyer ones.
  const candCap = Math.min(Math.max(maxThreads * 2, 24), 50);
  const cand: { mb: string; threadId: string }[] = [];
  const seenThread = new Set<string>();
  const collect = async (query: string) => {
    for (const mb of minerMailboxes()) {
      if (cand.length >= candCap) break;
      let stubs: { id: string; threadId: string }[] = [];
      try { stubs = await searchMessages(mb, query, Math.max(candCap, 60)); } catch { continue; }
      for (const s of stubs) {
        if (cand.length >= candCap) break;
        const key = `${mb}:${s.threadId}`;
        if (seenThread.has(key)) continue;
        seenThread.add(key);
        cand.push({ mb, threadId: s.threadId });
      }
    }
  };
  await collect(`subject:"${domain}"`);           // acquisition threads name the domain in the subject
  if (cand.length < candCap) await collect(`"${domain}" -from:domainiq -from:domainscout -subject:"monitoring alert" -subject:"domainIQ:"`);
  // 2. Pull candidate threads (newest-first) until we have `maxThreads` NON-EMPTY ones; a thread whose
  //    every message is noise/bulk (monitoring alert, Google-Drive share, mailer-daemon) contributes 0
  //    and does NOT consume a slot. Keep each thread's oldest `perThread` real messages (identity/price
  //    is usually stated early). Dedupe by Message-ID.
  const seenMid = new Set<string>();
  const out: GmailMessage[] = [];
  let keptThreads = 0;
  for (const { mb, threadId } of cand) {
    if (keptThreads >= maxThreads) break;
    let msgs: GmailMessage[] = [];
    try { msgs = await getThreadCapped(mb, threadId); } catch { continue; }
    const kept = msgs.filter((m) => !m.bulk && !isNoiseMsg(m)).sort((a, b) => a.date - b.date).slice(0, perThread);
    if (!kept.length) continue;   // all-noise thread → don't spend a slot on it
    keptThreads++;
    for (const m of kept) {
      const k = m.mid || m.id;
      if (seenMid.has(k)) continue;
      seenMid.add(k);
      out.push(m);
    }
  }
  return out;
}

// One LLM pass over a gathered message set → a MinedOwner (or null on any error).
async function mineOnce(domain: string, msgs: GmailMessage[], cap: number, key: string): Promise<MinedOwner | null> {
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system: SYSTEM, messages: [{ role: "user", content: transcript(domain, msgs).slice(0, cap) }] }),
    });
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<MinedOwner>;
    return {
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
  } catch { return null; }
}

// A result is "good enough" to stop escalating: a seller-side contact WITH a way to reach them.
function isConfident(m: MinedOwner | null): boolean {
  return !!m && m.seller_found && (!!m.email || (!!m.first_name && !!m.last_name)) && m.confidence !== "none";
}
// Rank a result for "keep the best across rounds" when none is confident yet.
function contactScore(m: MinedOwner | null): number {
  if (!m) return -1;
  return (m.seller_found ? 4 : 0) + (m.email ? 3 : 0) + (m.phone ? 1 : 0) + (m.first_name && m.last_name ? 2 : m.first_name ? 1 : 0);
}

// LLM: determine the seller-side point of contact we bought `domain` from. ESCALATES the thread window
// across rounds — a small window resolves most cards fast, but a deal whose seller negotiation is an
// OLDER thread behind the escrow/closing/buyer ones needs a wider net, so we widen until we get a
// confident contact (then stop). Reads the strictly-local mirror (zero Gmail); the only cost is the
// per-round Anthropic call, so escalation only fires when the previous round wasn't confident.
export async function mineOwnerForDomain(domain: string, env: NodeJS.ProcessEnv = process.env): Promise<MinedOwner> {
  const empty: MinedOwner = { seller_found: false, first_name: "", last_name: "", email: "", phone: "", channel: "", confidence: "none", buyer_context: "", evidence: "" };
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return empty;
  // Two escalation rounds keeps worst-case latency bounded (a 3rd 40-thread round made batches slow
  // enough to trip the client's fetch timeout). Round 2's 24-thread net still reaches an older seller
  // thread behind the escrow/closing ones.
  const ROUNDS: { maxThreads: number; cap: number }[] = [
    { maxThreads: 10, cap: 18000 },
    { maxThreads: 24, cap: 36000 },
  ];
  let best: MinedOwner | null = null;
  let sawMessages = false;
  for (const r of ROUNDS) {
    const msgs = await gatherMessages(domain, { maxThreads: r.maxThreads });
    if (!msgs.length) break;             // nothing to read at this (or any wider) window
    sawMessages = true;
    const out = await mineOnce(domain, msgs, r.cap, key);
    if (out && contactScore(out) > contactScore(best)) best = out;
    if (isConfident(out)) break;         // confident seller-side contact → stop widening
  }
  if (!sawMessages) return { ...empty, evidence: "No acquisition thread found in the deal mailboxes." };
  if (!best) return empty;
  // Deterministic backstop: have an email but no last name → pull the full name from the thread headers.
  if (best.email && !best.last_name) {
    const hit = await resolveNameFromThread(domain, best.email).catch(() => null);
    if (hit && hit.last) { best.first_name = best.first_name || hit.first; best.last_name = hit.last; }
  }
  return best;
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
export async function mineAllTxns(opts: { limit?: number; dry?: boolean; assignTo?: string | null } = {}): Promise<MineSummary> {
  const limit = opts.limit ?? 20;
  const dry = !!opts.dry;
  const assignTo = opts.assignTo || null;   // new cards go to whoever ran the mine (button); cron → unassigned
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
    }, assignTo);
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

// ---- Bulk RE-MINE of wrong-looking cards -------------------------------------------------------
// Cards created by the FIRST (first-10-messages) miner often read "broker / no candidate seller"
// because the escrow thread swamped the read. Re-mine them with the whole-thread logic, assign each
// to a reviewer (Judy), and stamp `remined_at` so each wrong card is re-processed EXACTLY ONCE (the
// background drain terminates). A card that turns up a real seller drops out of the wrong-set; one
// that stays broker/none is a genuine broker card (Dismiss).

export type RemineSummary = { scanned: number; updated: number; found: number; remaining: number; dry?: boolean; note?: string; results: { domain: string; found: boolean; confidence: string; name: string }[] };

// "Wrong-looking" = pending, not yet re-mined, AND (confidence broker/none OR no candidate name).
// Returns { columnMissing:true } when `remined_at` isn't migrated yet — the caller then refuses the
// unattended drain (it can't mark progress → would loop forever), but a bounded one-shot still runs.
// mode "wrong" = pending + not-yet-remined + (confidence broker/none OR no candidate name); mode "all"
// = every pending + not-yet-remined card (used to re-mine the WHOLE queue with the improved whole-thread
// miner now that it's local + free). `remined_at` still bounds each card to ONE re-mine so any drain
// terminates. Returns { columnMissing } when `remined_at` isn't migrated (caller refuses the unattended
// drain then, but a bounded one-shot still runs).
const WRONG_FILTER = "confidence.in.(broker,none),candidate_name.is.null";
async function selectWrongCards(limit: number, mode: "wrong" | "all" = "wrong"): Promise<{ rows: { id: string; domain: string }[]; columnMissing: boolean }> {
  // Fetch a POOL ordered by remined_at NULLS-FIRST (the unmined cards) and JS-filter to unmined. Ordering
  // nulls-first is essential: an earlier version ordered by txn_date and capped the pool, so once the
  // newest-dated pending cards were all re-mined, the still-unmined ones (older dates) fell OUTSIDE the
  // pool window and the drain found nothing to do (reported "0 re-mined" while the live count showed ~196
  // left). Nulls-first guarantees the unmined cards are at the top of the pool. JS-filter kept as a belt.
  let q = getDb().from(CARDS).select("id,domain,remined_at").eq("status", "pending");
  if (mode === "wrong") q = q.or(WRONG_FILTER);
  const { data, error } = await q.order("remined_at", { ascending: true, nullsFirst: true }).limit(Math.max(limit * 10, 120));
  if (error) {
    if (/remined_at/.test(error.message || "")) {
      let q2 = getDb().from(CARDS).select("id,domain").eq("status", "pending");
      if (mode === "wrong") q2 = q2.or(WRONG_FILTER);
      const { data: d2 } = await q2.order("txn_date", { ascending: false }).limit(limit);
      return { rows: (d2 as { id: string; domain: string }[]) || [], columnMissing: true };
    }
    return { rows: [], columnMissing: false };
  }
  const rows = ((data as { id: string; domain: string; remined_at: string | null }[]) || [])
    .filter((r) => !r.remined_at)
    .slice(0, limit)
    .map((r) => ({ id: r.id, domain: r.domain }));
  return { rows, columnMissing: false };
}

async function countWrongCards(mode: "wrong" | "all" = "wrong"): Promise<number> {
  try {
    let q = getDb().from(CARDS).select("id", { count: "exact", head: true }).eq("status", "pending").is("remined_at", null);
    if (mode === "wrong") q = q.or(WRONG_FILTER);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  } catch {
    try {
      let q = getDb().from(CARDS).select("id", { count: "exact", head: true }).eq("status", "pending");
      if (mode === "wrong") q = q.or(WRONG_FILTER);
      const { count } = await q;
      return count || 0;
    } catch { return 0; }
  }
}

// Clear the remined_at marker for the target pending set so a MANUAL re-sweep reprocesses every card
// with the current miner (the marker only exists to bound the unattended cron, not the manual button).
// Called ONCE at the start of a manual sweep (not per batch), so the drain still terminates. Fail-open
// (missing column → no-op; the drain then just processes the never-mined ones).
export async function clearRemineMarkers(mode: "wrong" | "all" = "all"): Promise<void> {
  try {
    let q = getDb().from(CARDS).update({ remined_at: null }).eq("status", "pending");
    if (mode === "wrong") q = q.or(WRONG_FILTER);
    await q.not("remined_at", "is", null);
  } catch { /* column missing / not migrated → nothing to clear */ }
}

// Return pending cards currently auto-assigned to `email` (Judy) back to the UNASSIGNED pool, so they
// reappear in every reviewer's "Assigned to me" (which includes unassigned). Called by the manual
// "Re-mine ALL pending" resweep to undo an earlier blanket auto-assignment. Only touches that one
// assignee's pending cards — hand-assignments to other people are left alone. Fail-open.
export async function returnAutoAssignedToPool(email: string): Promise<void> {
  try {
    await getDb().from(CARDS).update({ assigned_to: null }).eq("status", "pending").eq("assigned_to", email.toLowerCase());
  } catch { /* ignore */ }
}

// Mark a card as attempted (remined_at=now) WITHOUT changing its candidate data — used when a mine
// threw, so the card drops out of the unmined set and the drain keeps progressing. No-op pre-migration.
async function stampReminedAt(id: string): Promise<void> {
  try { await getDb().from(CARDS).update({ remined_at: new Date().toISOString() }).eq("id", id); } catch { /* column missing → ignore */ }
}

async function applyRemine(id: string, mined: MinedOwner, assignTo: string | null): Promise<void> {
  const base: Record<string, unknown> = {
    candidate_first_name: mined.first_name || null,
    candidate_last_name: mined.last_name || null,
    candidate_name: [mined.first_name, mined.last_name].filter(Boolean).join(" ") || null,
    candidate_email: mined.email || null,
    candidate_phone: mined.phone || null,
    channel: mined.channel || null,
    buyer_context: mined.buyer_context || null,
    confidence: mined.confidence,
    evidence: mined.evidence || null,
    updated_at: new Date().toISOString(),
  };
  if (assignTo) base.assigned_to = assignTo.toLowerCase();
  const { error } = await getDb().from(CARDS).update({ ...base, remined_at: new Date().toISOString() }).eq("id", id);
  if (error && /remined_at/.test(error.message || "")) await getDb().from(CARDS).update(base).eq("id", id);
}

// Re-mine a batch of wrong cards. `requireMarker` (the unattended cron) refuses when `remined_at`
// isn't migrated (can't guarantee termination); a bounded manual test passes requireMarker=false.
export async function remineWrongCards(opts: { limit?: number; dry?: boolean; assignTo?: string | null; requireMarker?: boolean; mode?: "wrong" | "all" } = {}): Promise<RemineSummary> {
  const limit = opts.limit ?? 15;
  const dry = !!opts.dry;
  const assignTo = opts.assignTo ?? null;
  const mode = opts.mode ?? "wrong";
  const out: RemineSummary = { scanned: 0, updated: 0, found: 0, remaining: 0, dry, results: [] };
  if (!isDbConfigured()) return { ...out, note: "DB not configured" };
  if (!process.env.ANTHROPIC_API_KEY) return { ...out, note: "ANTHROPIC_API_KEY not set on the admin project — the miner needs it. Set it, then run again." };
  const { rows, columnMissing } = await selectWrongCards(limit, mode);
  if (columnMissing && opts.requireMarker) {
    return { ...out, remaining: rows.length, note: "Run the owner_review.sql migration to add `remined_at` before the background drain (needed so it doesn't re-process the same cards). A manual test batch still works." };
  }
  // Mine in parallel pools. Gmail is NO LONGER the constraint — the miner reads the strictly-local
  // mirror now (zero Gmail), so the only limiter is the per-card Anthropic call. Default concurrency 4
  // (env OWNER_REVIEW_REMINE_CONCURRENCY, max 8) drains faster; lower it only if Anthropic 429s.
  const CONC = Math.max(1, Math.min(Number(process.env.OWNER_REVIEW_REMINE_CONCURRENCY) || 6, 8));
  for (let i = 0; i < rows.length; i += CONC) {
    const slice = rows.slice(i, i + CONC);
    const mined = await Promise.all(slice.map((c) => mineOwnerForDomain(c.domain).then((m) => ({ c, m })).catch(() => ({ c, m: null as MinedOwner | null }))));
    for (const { c, m } of mined) {
      out.scanned++;
      if (dry) { if (m) { if (m.seller_found) out.found++; out.results.push({ domain: c.domain, found: m.seller_found, confidence: m.confidence, name: [m.first_name, m.last_name].filter(Boolean).join(" ") }); } continue; }
      if (!m) {
        // The mine threw (transient). STAMP remined_at anyway so this card drops out of the unmined
        // set — guarantees the drain strictly progresses and always completes "run ALL" (a persistent
        // failure can't re-loop forever). Its existing candidate data is untouched; re-mine it by hand.
        await stampReminedAt(c.id).catch(() => {});
        continue;
      }
      if (m.seller_found) out.found++;
      out.results.push({ domain: c.domain, found: m.seller_found, confidence: m.confidence, name: [m.first_name, m.last_name].filter(Boolean).join(" ") });
      await applyRemine(c.id, m, assignTo);
      out.updated++;
    }
  }
  out.remaining = await countWrongCards(mode);
  return out;
}
