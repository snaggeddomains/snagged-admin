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

export type GmailFeature =
  | "owner-review-mine"
  | "owner-review-remine"
  | "deal-emails"
  | "pitch-scan"
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

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
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

// Called by gget BEFORE a read. Throws GmailBudgetError if a BACKGROUND feature's mailbox is over
// budget (hard-stop). Interactive features are never hard-stopped here (they have their own high
// ceiling, enforced softly below only to catch a runaway). Fail-open on any governor error.
export async function assertReadBudget(mailbox: string): Promise<void> {
  if (disabled) return;
  const { feature, interactive } = currentCtx();
  try {
    const usage = await currentUsage(mailbox);
    const [rCap, bCap] = interactive ? [IX_READS, IX_BYTES] : [BG_READS, BG_BYTES];
    if (usage.reads >= rCap || usage.bytes >= bCap) throw new GmailBudgetError(mailbox, feature);
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
  { mailbox: string; reads: number; bytes: number; by_feature: Record<string, { reads: number; bytes: number }>; bg_read_cap: number; bg_byte_cap: number }[]
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
    out.push({ mailbox: mb, reads, bytes, by_feature, bg_read_cap: BG_READS, bg_byte_cap: BG_BYTES });
  }
  return out;
}

export const CAPS = { BG_READS, BG_BYTES, IX_READS, IX_BYTES };
