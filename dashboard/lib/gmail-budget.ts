// Gmail read GOVERNOR — the single throttle every deal-mailbox read passes through, so no
// feature (or the sum of them) can eat the per-user Gmail quota that Superhuman shares. Every
// read in lib/gmail.ts `gget` charges a per-(mailbox, day) ledger tagged by FEATURE, and a
// background read is REFUSED once its mailbox hits the daily budget (hard-stop, fail-open —
// the human client always keeps headroom). Interactive reads (the Email module, on-demand
// buttons) get a separate, higher ceiling so they always work.
//
// Why byte-aware: Gmail throttling is byte-based (Superhuman confirmed) — a few giant threads
// re-downloaded hundreds of times is what blows the quota — so the ledger tracks estimated
// bytes as well as call count, and either cap trips the hard-stop.
//
// Setup: run scripts/gmail_read_budget.sql on the domain-owner-research (PRODUCTION) project.
// Degrades fully open pre-migration (the RPC/table missing → charging + capping no-op, reads
// proceed exactly as before), so this can land before the SQL runs.

import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, isDbConfigured } from "./supabase";
import { getHeartbeat, recordHeartbeat } from "./cron-heartbeat";

export type GmailFeature =
  | "owner-review-mine"
  | "owner-review-remine"
  | "deal-emails"
  | "client-corpus"
  | "marketplace-deals"
  | "email-threads"        // research chat email-attach (internal)
  | "email-module"         // the admin Email compose tool (interactive)
  | "leads"
  | "other";

// Interactive features get the higher ceiling + are never hard-stopped by the BACKGROUND cap
// (a person waiting on a click should not be blocked by a cron's spending).
const INTERACTIVE = new Set<GmailFeature>(["email-module"]);

type FeatureCtx = { feature: GmailFeature; interactive: boolean };
const als = new AsyncLocalStorage<FeatureCtx>();

// Run `fn` with every Gmail read inside it charged/tagged to `feature`. Wrap each cron handler
// and the Email API route in this. Nesting is fine (innermost wins).
export function withGmailFeature<T>(feature: GmailFeature, fn: () => Promise<T>): Promise<T> {
  return als.run({ feature, interactive: INTERACTIVE.has(feature) }, fn);
}
function currentCtx(): FeatureCtx {
  return als.getStore() || { feature: "other", interactive: false };
}

// ---- caps (self-imposed, conservative, env-tunable) ---------------------------------------
// Gmail's real per-user limit is opaque and unraisable, so these sit well UNDER what caused the
// throttle (today's damage was ~hundreds of whole-thread reads on ONE mailbox). Per mailbox,
// per day. Background jobs share the background cap; interactive gets its own higher ceiling.
const BG_READS = Number(process.env.GMAIL_BG_READS_PER_DAY) || 300;
const BG_BYTES = Number(process.env.GMAIL_BG_BYTES_PER_DAY) || 200 * 1024 * 1024; // 200 MB
const IX_READS = Number(process.env.GMAIL_IX_READS_PER_DAY) || 1500;
const IX_BYTES = Number(process.env.GMAIL_IX_BYTES_PER_DAY) || 1024 * 1024 * 1024; // 1 GB

// Safety margin: background reads STOP at this fraction of the cap — we never want to actually
// REACH the daily cap (that risks the shared per-user quota Superhuman draws on). Default 70%.
const SAFETY = Math.min(1, Math.max(0.1, Number(process.env.GMAIL_BG_SAFETY_PCT) || 0.7));
// APPROACH line (< SAFETY): the GLOBAL circuit-breaker trips here, EARLIER than any one mailbox's own
// stop — so the instant ANY watched mailbox is merely *approaching* its cap, ALL background reads halt
// everywhere. This is the universal "any user about to hit their limit → hard skip" guarantee, and the
// ~10-point buffer below the stop absorbs a concurrent-burst overshoot (what pushed brian past his stop).
const APPROACH = Math.min(SAFETY, Math.max(0.1, Number(process.env.GMAIL_BG_APPROACH_PCT) || 0.6));

// The mailboxes we read (mirror of gmail.ts dealMailboxes — kept here to avoid an import cycle,
// since gmail.ts imports this module). The GLOBAL circuit-breaker watches ALL of them.
function watchedMailboxes(): string[] {
  return (process.env.GMAIL_DEAL_MAILBOXES || "rob@snagged.com,brian@snagged.com,rob@snagged.co,brian@snagged.co")
    .split(",").map((s) => s.trim()).filter(Boolean);
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// OPTIONAL manual permanent block — mailboxes our BACKGROUND code must never read regardless of
// usage (env override, default EMPTY). The AUTOMATIC protection below (the approach-line breaker)
// already covers "any user about to hit their limit"; this is just a manual escape hatch (e.g. to
// hard-exclude a box entirely until it's served from the local mirror). Interactive Email is exempt.
function bgSkipMailboxes(): Set<string> {
  const raw = process.env.GMAIL_BG_SKIP_MAILBOXES ?? "";
  return new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}
export function isBackgroundSkipped(mailbox: string): boolean {
  return bgSkipMailboxes().has(mailbox.trim().toLowerCase());
}

// ── MASTER KILL SWITCH ─────────────────────────────────────────────────────────────────────
// An admin panic button (Inbox Load page) that HARD-CUTS every Gmail read across both apps —
// crons, automated, on-demand, AND the interactive Email tool. Stored in cron_heartbeats (no
// migration), read on every read via a ~10s cache so it's cheap. When on, assertReadBudget throws
// for everything → callers fail open / return the throttle message. Highest precedence of all.
const KILL = "gmail_kill_switch";
let killCache: { at: number; on: boolean } = { at: 0, on: false };
async function killSwitchActive(): Promise<boolean> {
  if (Date.now() - killCache.at < 10000) return killCache.on;
  try {
    const hb = await getHeartbeat(KILL);
    const on = Boolean((hb?.last_result as { killed?: boolean } | null)?.killed);
    killCache = { at: Date.now(), on };
    return on;
  } catch {
    return killCache.on; // fail to last-known state (default off)
  }
}
export async function setGmailKillSwitch(on: boolean, by: string): Promise<void> {
  await recordHeartbeat(KILL, { killed: on, by, at: new Date().toISOString() });
  killCache = { at: Date.now(), on }; // reflect immediately for this instance
}
export async function gmailKillSwitchStatus(): Promise<{ on: boolean; by: string | null; at: string | null }> {
  const hb = await getHeartbeat(KILL);
  const r = (hb?.last_result as { killed?: boolean; by?: string; at?: string } | null) || null;
  return { on: Boolean(r?.killed), by: r?.by ?? null, at: r?.at ?? null };
}

// Per-invocation cache of today's totals so we don't hit the DB before every single read.
// (A cron is a single-purpose invocation; a slightly stale count is fine for a budget.)
type Usage = { reads: number; bytes: number };
const cache = new Map<string, { at: number; usage: Usage }>();
const CACHE_MS = 15000;

let disabled = false; // flips true if the RPC/table isn't there (pre-migration) → govern no-op

async function currentUsage(mailbox: string): Promise<Usage> {
  const key = `${mailbox}|${utcDay()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.usage;
  let usage: Usage = { reads: 0, bytes: 0 };
  if (isDbConfigured() && !disabled) {
    try {
      const { data, error } = await getDb()
        .from("gmail_read_budget")
        .select("reads, est_bytes")
        .eq("mailbox", mailbox)
        .eq("day", utcDay())
        .maybeSingle();
      if (error) throw error;
      if (data) usage = { reads: data.reads || 0, bytes: Number(data.est_bytes) || 0 };
    } catch (e: unknown) {
      if (isMissing(e)) disabled = true; // table not migrated yet → govern off
    }
  }
  cache.set(key, { at: Date.now(), usage });
  return usage;
}

function isMissing(e: unknown): boolean {
  const m = e as { code?: string; message?: string };
  const s = `${m?.code || ""} ${m?.message || ""}`.toLowerCase();
  return s.includes("42p01") || s.includes("pgrst205") || s.includes("42883") /* fn missing */ ||
    s.includes("could not find") || s.includes("does not exist");
}

// Standard user-facing message for a human-initiated pull that hits the throttle line — shown
// verbatim in the UI so the person knows it's a rate limit, not a failure, and to retry tomorrow.
export const GMAIL_BUDGET_MESSAGE =
  "Can't pull emails right now — we've reached today's email-read limit (throttling protection for the shared inbox quota). Please check back tomorrow.";

export class GmailBudgetError extends Error {
  mailbox: string;
  feature: GmailFeature;
  constructor(mailbox: string, feature: GmailFeature) {
    super(`Gmail daily read budget reached for ${mailbox} (feature ${feature}) — backing off to protect the shared quota.`);
    this.name = "GmailBudgetError";
    this.mailbox = mailbox;
    this.feature = feature;
  }
}
export function isGmailBudgetError(e: unknown): e is GmailBudgetError {
  return e instanceof GmailBudgetError || (e as { name?: string })?.name === "GmailBudgetError";
}

// Is ANY watched mailbox at/over the safety threshold of either background cap? If so, ALL
// background reads stop everywhere (global circuit-breaker) — so if Rob/Brian/(any deal box) is
// even getting close, no account risks the shared throttle. Cached ~15s (each mailbox's usage is
// itself cached), so it's cheap to check on every read.
let haltCache: { at: number; tripped: { mailbox: string; reads: number; bytes: number } | null } = { at: 0, tripped: null };
async function backgroundHalt(): Promise<{ mailbox: string; reads: number; bytes: number } | null> {
  if (disabled) return null;
  if (Date.now() - haltCache.at < CACHE_MS) return haltCache.tripped;
  let tripped: { mailbox: string; reads: number; bytes: number } | null = null;
  for (const mb of watchedMailboxes()) {
    const u = await currentUsage(mb);
    // Trip at the APPROACH line (earlier than the per-mailbox stop) → any box nearing its cap halts ALL.
    if (u.reads >= APPROACH * BG_READS || u.bytes >= APPROACH * BG_BYTES) { tripped = { mailbox: mb, ...u }; break; }
  }
  haltCache = { at: Date.now(), tripped };
  return tripped;
}

// Called by gget BEFORE a read.
//  - BACKGROUND feature: refused (GmailBudgetError, hard-stop) if the GLOBAL circuit-breaker is
//    tripped (any watched mailbox ≥ SAFETY×cap) OR this mailbox is itself ≥ SAFETY×cap. So we stop
//    at the safety margin, never at 100%, and one hot mailbox halts background reads for all.
//  - INTERACTIVE feature (the Email tool): never hard-stopped by the background trip; only its own
//    high ceiling catches a runaway. A person waiting on a click keeps working.
// Fail-open on any governor error — never block a real read on our own bookkeeping.
export async function assertReadBudget(mailbox: string): Promise<void> {
  const { feature, interactive } = currentCtx();
  // (0) MASTER KILL SWITCH — an admin hard-cut of ALL reads (crons/automated/on-demand/interactive).
  // Highest precedence; applies even pre-migration of the budget table.
  if (await killSwitchActive()) throw new GmailBudgetError(mailbox, feature);
  // Manual permanent block (env, default empty) — enforced even pre-migration, background only.
  if (!interactive && isBackgroundSkipped(mailbox)) throw new GmailBudgetError(mailbox, feature);
  if (disabled) return;
  try {
    // The GLOBAL circuit-breaker now applies to EVERYTHING, interactive included: if ANY watched
    // mailbox is approaching its cap, all reads pause — so even the Email tool can't push a mailbox
    // toward the shared throttle during a danger window.
    const halt = await backgroundHalt();
    if (halt) throw new GmailBudgetError(halt.mailbox, feature);
    if (interactive) {
      // Interactive keeps its own higher ceiling for normal use (only the global breaker + kill
      // switch override it).
      const u = await currentUsage(mailbox);
      if (u.reads >= IX_READS || u.bytes >= IX_BYTES) throw new GmailBudgetError(mailbox, feature);
      return;
    }
    const usage = await currentUsage(mailbox);
    if (usage.reads >= SAFETY * BG_READS || usage.bytes >= SAFETY * BG_BYTES) throw new GmailBudgetError(mailbox, feature);
  } catch (e) {
    if (isGmailBudgetError(e)) throw e;
    /* governor read failed — fail open, never block a real read on our own bookkeeping */
  }
}

// Called by gget AFTER a successful read. Best-effort atomic increment; updates the cache so the
// next assertReadBudget in this invocation sees the new total without a DB round-trip.
export async function chargeRead(mailbox: string, bytes: number): Promise<void> {
  if (disabled || !isDbConfigured()) return;
  const { feature } = currentCtx();
  const day = utcDay();
  const key = `${mailbox}|${day}`;
  const prev = cache.get(key)?.usage || { reads: 0, bytes: 0 };
  cache.set(key, { at: Date.now(), usage: { reads: prev.reads + 1, bytes: prev.bytes + Math.max(0, bytes) } });
  try {
    await getDb().rpc("gmail_charge_read", {
      p_mailbox: mailbox, p_day: day, p_feature: feature, p_reads: 1, p_bytes: Math.max(0, Math.round(bytes)),
    });
  } catch (e) {
    if (isMissing(e)) disabled = true;
    /* else best-effort — a lost charge just under-counts slightly */
  }
}

// Read-only status for the "Inbox load" dashboard (per mailbox, today).
export async function budgetStatus(mailboxes: string[]): Promise<
  { mailbox: string; reads: number; bytes: number; by_feature: Record<string, { reads: number; bytes: number }>; bg_read_cap: number; bg_byte_cap: number; bg_read_stop: number; bg_byte_stop: number; halted: boolean }[]
> {
  const day = utcDay();
  const out: Awaited<ReturnType<typeof budgetStatus>> = [];
  for (const mb of mailboxes) {
    let reads = 0, bytes = 0, by_feature: Record<string, { reads: number; bytes: number }> = {};
    if (isDbConfigured()) {
      try {
        const { data } = await getDb()
          .from("gmail_read_budget")
          .select("reads, est_bytes, by_feature")
          .eq("mailbox", mb).eq("day", day).maybeSingle();
        if (data) { reads = data.reads || 0; bytes = Number(data.est_bytes) || 0; by_feature = data.by_feature || {}; }
      } catch { /* fail-open → zeros */ }
    }
    // Background reads stop at SAFETY×cap — surface both the stop line and whether this box has hit it.
    const readStop = Math.round(SAFETY * BG_READS);
    const byteStop = Math.round(SAFETY * BG_BYTES);
    out.push({
      mailbox: mb, reads, bytes, by_feature,
      bg_read_cap: BG_READS, bg_byte_cap: BG_BYTES,
      bg_read_stop: readStop, bg_byte_stop: byteStop,
      halted: reads >= readStop || bytes >= byteStop,
    });
  }
  return out;
}

export const CAPS = { BG_READS, BG_BYTES, IX_READS, IX_BYTES, SAFETY, APPROACH };
