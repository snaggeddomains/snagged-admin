// Deals persistence — our native buy-side CRM (Pipedrive replaced). One row per deal in
// the shared main project (admin SUPABASE_URL). The service key bypasses RLS. All reads/
// writes go through here so the API + board + detail stay consistent.

import { getDb, isDbConfigured } from "../supabase";
import { entryStage, normalizeBudget, budgetMaxFor, type Stage, type Status } from "./stages";

const DEALS = "deals";
const ACTIVITY = "deal_activity";
const EMAILS = "deal_emails";

export type Deal = {
  id: string;
  domain: string;
  additional_domains: string | null;
  buyer_name: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  org_name: string | null;
  budget_range: string | null;
  appraisal_value: number | null;
  asking_price: number | null;      // latest owner asking price
  current_offer: number | null;     // latest client offer (paired with asking for the at-a-glance gap)
  sale_price: number | null;    // final price paid (captured at Close Won)
  commission: number | null;    // our commission on the close
  upfront_fee: number | null;   // what we charged the client up front to pursue the acquisition
  upfront_paid: boolean | null; // auto-true once the deal reaches Research & Outreach
  sam_split: boolean | null;    // Sam takes a cut of the upfront fee on this deal (permission-gated toggle)
  sam_split_at: string | null;  // when the split was taken on — for month-accurate reporting
  source: string | null;
  heard_about: string | null;  // "How did you hear about us?" — marketing attribution off the inquiry form
  intent: string | null;       // "Acquire or Sell?" off the inquiry form — canonicalized to "Acquire"/"Sell"
  priority: string | null;
  budget_max: number | null;
  owner_email: string | null;
  stage: string;
  status: string;
  lost_reason: string | null;
  report_link: string | null;
  likely_owner: string | null;
  owner_contact: string | null;
  reachability: string | null;
  notes: string | null;
  tags: string[] | null;
  lead_key: string | null;
  domain_owner_id: string | null;  // confirmed owner record (set at Negotiating)
  // Which research-derived fields the user has MANUALLY edited — those stop auto-syncing
  // from the research report; everything else auto-refreshes on view. e.g. {likely_owner:true}.
  owner_manual: Record<string, boolean> | null;
  created_by: string | null;
  position: number | null;
  created_at: string;
  updated_at: string;
};

export type Activity = {
  id: string;
  deal_id: string;
  user_email: string | null;
  kind: string;
  body: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export type DealEmail = {
  id: string;
  deal_id: string;
  mailbox: string | null;
  thread_id: string;
  msg_id: string | null;   // per-message id (RFC Message-ID) → one row per email, not per thread
  subject: string | null;
  snippet: string | null;
  body: string | null;
  from_addr: string | null;
  msg_date: string | null;
  ingested_at: string;
};

export type CreateDealInput = {
  domain: string;
  additionalDomains?: string;
  buyerName?: string;
  buyerEmail?: string;
  buyerPhone?: string;
  orgName?: string;
  budgetRange?: string;
  appraisalValue?: number;
  askingPrice?: number;
  upfrontFee?: number;      // optional fee we charge the client up front to pursue the acquisition
  source?: string;
  heardAbout?: string;
  intent?: string;          // "Acquire or Sell?" off the inquiry form
  priority?: string;
  ownerEmail?: string;      // assignee
  reportLink?: string;
  likelyOwner?: string;
  ownerContact?: string;
  reachability?: string;
  notes?: string;
  tags?: string[];
  leadKey?: string;
  createdBy?: string;
};

export function dealsConfigured(): boolean {
  return isDbConfigured();
}

const norm = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s || null;
};

// Canonicalize the inquiry form's "Acquire or Sell?" answer to a clean "Acquire" / "Sell"
// so the report sorts/filters/groups cleanly (the form value is free-ish, e.g. "Acquire a
// domain" / "I want to sell"). Anything unrecognized is kept as-is (title-cased) or null.
const normIntent = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const l = s.toLowerCase();
  // NB the inquiry form's value is commonly misspelled "Aquire a domain" (no "c"),
  // so match ac?quir to catch both spellings.
  if (/sell|selling/.test(l)) return "Sell";
  if (/ac?quir|buy|buying|purchas/.test(l)) return "Acquire";
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Find-or-create by (domain, buyer email). Returns { deal, created }. Same buyer + domain
// never duplicates (matches the old Pipedrive idempotency), across every convert surface.
export async function createDeal(input: CreateDealInput): Promise<{ deal: Deal; created: boolean }> {
  const domain = String(input.domain || "").trim().toLowerCase();
  if (!domain) throw new Error("domain required");
  const buyerEmail = input.buyerEmail ? input.buyerEmail.trim().toLowerCase() : null;

  // Idempotency: exact domain + buyer.
  const existing = await getDb().from(DEALS).select("*")
    .eq("domain", domain)
    .eq("buyer_email", buyerEmail ?? "")
    .maybeSingle();
  if (existing.data) return { deal: existing.data as Deal, created: false };

  const ownerEmail = input.ownerEmail ? input.ownerEmail.trim().toLowerCase() : null;
  const stage: Stage = entryStage(Boolean(ownerEmail));
  const row = {
    domain,
    additional_domains: norm(input.additionalDomains),
    buyer_name: norm(input.buyerName),
    buyer_email: buyerEmail,
    buyer_phone: norm(input.buyerPhone),
    org_name: norm(input.orgName),
    budget_range: normalizeBudget(input.budgetRange) || norm(input.budgetRange),
    appraisal_value: input.appraisalValue ?? null,
    asking_price: input.askingPrice ?? null,
    upfront_fee: input.upfrontFee ?? null,
    source: norm(input.source),
    heard_about: norm(input.heardAbout),
    intent: normIntent(input.intent),
    priority: norm(input.priority),
    budget_max: budgetMaxFor(input.budgetRange),
    owner_email: ownerEmail,
    stage,
    status: "open",
    report_link: norm(input.reportLink),
    likely_owner: norm(input.likelyOwner),
    owner_contact: norm(input.ownerContact),
    reachability: norm(input.reachability),
    notes: norm(input.notes),
    tags: input.tags && input.tags.length ? input.tags : [],
    lead_key: norm(input.leadKey),
    created_by: norm(input.createdBy),
    position: Date.now(), // newest sinks to the bottom of the column initially
  };
  let ins = await getDb().from(DEALS).insert(row).select("*").single();
  // Degrade gracefully before optional-column migrations land (budget_max, heard_about, intent).
  // The DB reports one missing column at a time, so drop the named one and retry a few times.
  const OPTIONAL = ["budget_max", "heard_about", "intent"];
  const mut = row as Record<string, unknown>;
  for (let i = 0; ins.error && i < OPTIONAL.length; i++) {
    const msg = ins.error.message;
    const miss = OPTIONAL.find((c) => new RegExp(c, "i").test(msg) && c in mut);
    if (!miss) break;
    delete mut[miss];
    ins = await getDb().from(DEALS).insert(mut).select("*").single();
  }
  if (ins.error) {
    // A concurrent create raced us to the unique index — re-read and return it.
    const again = await getDb().from(DEALS).select("*").eq("domain", domain).eq("buyer_email", buyerEmail ?? "").maybeSingle();
    if (again.data) return { deal: again.data as Deal, created: false };
    throw new Error(`createDeal: ${ins.error.message}`);
  }
  const deal = ins.data as Deal;
  await addActivity(deal.id, { user_email: row.created_by, kind: "created", body: `Deal created for ${domain}`, meta: null });
  return { deal, created: true };
}

// Owner-scoped list. `all` (deals.all) returns everything. Otherwise a user sees strictly
// their OWN deals — UNLESS `inbox` (deals.inbox) is set, which adds the unassigned Inbox
// so they can claim new/unassigned work.
export async function listDeals(opts: { all: boolean; me: string; inbox?: boolean; status?: string; q?: string } = { all: true, me: "" }): Promise<Deal[]> {
  let query = getDb().from(DEALS).select("*").order("stage").order("position");
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.q) query = query.or(`domain.ilike.%${opts.q}%,buyer_name.ilike.%${opts.q}%,buyer_email.ilike.%${opts.q}%,org_name.ilike.%${opts.q}%`);
  if (!opts.all && opts.me) {
    const me = opts.me.toLowerCase();
    query = opts.inbox ? query.or(`owner_email.eq.${me},owner_email.is.null`) : query.eq("owner_email", me);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listDeals: ${error.message}`);
  return (data as Deal[]) || [];
}

export type ReportFilters = {
  status?: string; owner?: string; stage?: string; source?: string; heardAbout?: string; priority?: string;
  intent?: string;   // "Acquire" / "Sell" off the inquiry form
  budgetBand?: string; minAsking?: number; maxAsking?: number; q?: string; from?: string; to?: string;
  samSplit?: "yes" | "no";   // filter to deals Sam splits (or not); when "yes", the date range
                              // keys off sam_split_at (the month he TOOK it on) — for monthly reports.
};

// The America/New_York UTC offset (minutes, e.g. -240 EDT / -300 EST) for a given instant —
// DST-correct via Intl, no tz library.
function etOffsetMinutes(at: Date): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at).reduce((o, x) => (o[x.type] = x.value, o), {} as Record<string, string>);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour === 24 ? 0 : +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}
// A bare 'YYYY-MM-DD' from the report picker is an America/New_York CALENDAR day (that's how the team
// thinks about "today"). Convert its start/end to the real UTC instant so a deal created at 10pm ET
// (= next-day UTC) still counts for "today". Pass a full ISO through unchanged.
function etDayBoundaryUtc(dateStr: string, endOfDay: boolean): string {
  if (/[T:]/.test(dateStr)) return dateStr; // already a full timestamp — use as-is
  const [y, m, d] = dateStr.split("-").map(Number);
  const wall = endOfDay ? Date.UTC(y, m - 1, d, 23, 59, 59, 999) : Date.UTC(y, m - 1, d, 0, 0, 0, 0);
  const off = etOffsetMinutes(new Date(wall));
  return new Date(wall - off * 60000).toISOString();
}

// Unscoped, filterable query across ALL deals — for the Reporting view (gated by
// deals.reports). Every filter is optional; capped for safety. `withHeard` includes the
// heard_about clauses; on a pre-migration DB (no heard_about column) the query is retried
// without them so the report still loads. Date range is interpreted in America/New_York.
export async function reportDeals(f: ReportFilters): Promise<Deal[]> {
  const build = (withHeard: boolean, withSamSplit: boolean, withIntent: boolean) => {
    // When filtering to Sam's splits, bound the date range by WHEN he took it on (sam_split_at),
    // so "This month" = deals Sam split this month, not deals created this month.
    const dateCol = withSamSplit && f.samSplit === "yes" ? "sam_split_at" : "created_at";
    let query = getDb().from(DEALS).select("*").order("created_at", { ascending: false }).limit(2000);
    if (f.status) query = query.eq("status", f.status);
    if (f.owner) query = f.owner === "__inbox__" ? query.is("owner_email", null) : query.eq("owner_email", f.owner.toLowerCase());
    if (f.stage) query = query.eq("stage", f.stage);
    if (f.source) query = query.eq("source", f.source);
    if (withHeard && f.heardAbout) query = query.ilike("heard_about", `%${f.heardAbout}%`);
    if (withIntent && f.intent) query = query.eq("intent", f.intent);
    if (f.priority) query = query.eq("priority", f.priority);
    if (f.budgetBand) query = query.eq("budget_range", f.budgetBand);
    if (f.minAsking != null) query = query.gte("asking_price", f.minAsking);
    if (f.maxAsking != null) query = query.lte("asking_price", f.maxAsking);
    if (withSamSplit && f.samSplit === "yes") query = query.eq("sam_split", true);
    if (withSamSplit && f.samSplit === "no") query = query.or("sam_split.is.null,sam_split.eq.false");
    if (f.q) {
      const cols = ["domain", "buyer_name", "buyer_email", "org_name", ...(withHeard ? ["heard_about"] : [])];
      query = query.or(cols.map((c) => `${c}.ilike.%${f.q}%`).join(","));
    }
    if (f.from) query = query.gte(dateCol, etDayBoundaryUtc(f.from, false));
    if (f.to) query = query.lte(dateCol, etDayBoundaryUtc(f.to, true));
    return query;
  };
  let { data, error } = await build(true, true, true);
  // Retry without each optional column the DB doesn't have yet (one at a time).
  if (error && /heard_about/i.test(error.message)) ({ data, error } = await build(false, true, true));
  if (error && /sam_split/i.test(error.message)) ({ data, error } = await build(true, false, true));
  if (error && /intent/i.test(error.message)) ({ data, error } = await build(true, true, false));
  if (error) throw new Error(`reportDeals: ${error.message}`);
  return (data as Deal[]) || [];
}

// Aggregates for the report header (counts + value rollups).
export function reportAggregates(deals: Deal[]) {
  const val = (d: Deal) => d.asking_price || d.appraisal_value || 0;
  const byStage: Record<string, number> = {}, byOwner: Record<string, number> = {}, byStatus: Record<string, number> = {};
  let askingTotal = 0;
  for (const d of deals) {
    byStage[d.stage] = (byStage[d.stage] || 0) + 1;
    byOwner[d.owner_email || "Inbox"] = (byOwner[d.owner_email || "Inbox"] || 0) + 1;
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    askingTotal += val(d);
  }
  return { count: deals.length, askingTotal, byStage, byOwner, byStatus };
}

// Is there already a deal for this domain? Returns the best match (an open one first,
// else the newest) so a research surface can offer "View deal" instead of creating a dup.
export async function findDealByDomain(domain: string): Promise<Deal | null> {
  const d = String(domain || "").trim().toLowerCase();
  if (!d) return null;
  const { data, error } = await getDb().from(DEALS).select("*").eq("domain", d)
    .order("created_at", { ascending: false }).limit(25);
  if (error || !data || !data.length) return null;
  const rows = data as Deal[];
  return rows.find((r) => r.status === "open") || rows[0];
}

// Buyer typeahead — known buyers from prior deals (returning clients). Matches name or
// email, dedupes by (name|email), newest first. Powers the New-deal / convert autocomplete.
export type BuyerSuggestion = { name: string | null; email: string | null; company: string | null };
export async function searchBuyers(q: string, limit = 8): Promise<BuyerSuggestion[]> {
  const s = String(q || "").trim();
  if (s.length < 2) return [];
  const like = `%${s}%`;
  const { data, error } = await getDb()
    .from(DEALS)
    .select("buyer_name,buyer_email,org_name,created_at")
    .or(`buyer_name.ilike.${like},buyer_email.ilike.${like}`)
    .not("buyer_name", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error || !data) return [];
  const seen = new Set<string>();
  const out: BuyerSuggestion[] = [];
  for (const r of data as { buyer_name: string | null; buyer_email: string | null; org_name: string | null }[]) {
    const key = `${(r.buyer_name || "").toLowerCase()}|${(r.buyer_email || "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: r.buyer_name, email: r.buyer_email, company: r.org_name });
    if (out.length >= limit) break;
  }
  return out;
}

export async function getDeal(id: string): Promise<Deal | null> {
  const { data, error } = await getDb().from(DEALS).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getDeal: ${error.message}`);
  return (data as Deal) || null;
}

// Fetch a set of deals by id (order preserved to match the caller's id order). Used by the
// "Shared with me" scope + My Tasks, which resolve a list of ids to full deals.
export async function getDealsByIds(ids: string[]): Promise<Deal[]> {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return [];
  const { data, error } = await getDb().from(DEALS).select("*").in("id", want);
  if (error) return [];
  const byId = new Map((data as Deal[]).map((d) => [d.id, d]));
  return want.map((id) => byId.get(id)).filter(Boolean) as Deal[];
}

// Patch mutable fields. Records a field_change / stage_change / status_change / assignment
// activity for the meaningful ones. `actor` is the acting user's email.
export async function updateDeal(id: string, patch: Record<string, unknown>, actor: string | null): Promise<Deal> {
  const before = await getDeal(id);
  if (!before) throw new Error("deal not found");
  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  // Keep budget canonical + the numeric sort key in sync when budget changes.
  if (Object.prototype.hasOwnProperty.call(patch, "budget_range")) {
    const raw = patch.budget_range as string | null;
    update.budget_range = normalizeBudget(raw) || raw || null;
    update.budget_max = budgetMaxFor(raw);
  }
  // Keep the WON stage/column and status in sync (both directions) — "Closed - Won" ⇔ won.
  // Lost has NO column: marking a deal lost keeps its working stage + a LOST badge (like
  // not_proceeded/archived), so we don't relocate its stage.
  const hasStatus = Object.prototype.hasOwnProperty.call(patch, "status");
  const hasStage = Object.prototype.hasOwnProperty.call(patch, "stage");
  if (hasStatus && !hasStage) {
    if (patch.status === "won") update.stage = "Closed - Won";
    else if (patch.status === "open" && /^Closed - /.test(before.stage || "")) update.stage = "Assigned"; // reopen a won deal → back onto the board
  } else if (hasStage && !hasStatus) {
    if (patch.stage === "Closed - Won") update.status = "won";
  }
  // Reaching "Research & Outreach" means the client paid the upfront fee to pursue it — flip
  // the paid flag automatically (once; a manual edit can still override).
  if (hasStage && patch.stage === "Research & Outreach" && !before.upfront_paid) {
    update.upfront_paid = true;
  }
  // Degrade gracefully before a column's migration: if the update names a column that
  // doesn't exist yet (budget_max, sale_price, commission, …), strip it + retry.
  let payload = update;
  let upd = await getDb().from(DEALS).update(payload).eq("id", id).select("*").single();
  for (let i = 0; i < 4 && upd.error; i++) {
    const m = /column "?([a-z_]+)"? of relation|Could not find the '([a-z_]+)' column/i.exec(upd.error.message);
    const col = m && (m[1] || m[2]);
    if (!col || !(col in payload)) break;
    const { [col]: _drop, ...rest } = payload;
    payload = rest;
    upd = await getDb().from(DEALS).update(payload).eq("id", id).select("*").single();
  }
  if (upd.error) throw new Error(`updateDeal: ${upd.error.message}`);
  const after = upd.data as Deal;

  if (patch.stage !== undefined && patch.stage !== before.stage) {
    await addActivity(id, { user_email: actor, kind: "stage_change", body: null, meta: { from: before.stage, to: after.stage } });
  }
  if (patch.status !== undefined && patch.status !== before.status) {
    await addActivity(id, { user_email: actor, kind: "status_change", body: after.lost_reason || null, meta: { from: before.status, to: after.status } });
  }
  if (patch.owner_email !== undefined && (patch.owner_email || null) !== before.owner_email) {
    await addActivity(id, { user_email: actor, kind: "assignment", body: null, meta: { from: before.owner_email, to: after.owner_email } });
  }
  return after;
}

// Toggle the "Sam splits upfront" flag (permission-gated by the caller). Stamps sam_split_at when
// turned ON (the month Sam took it on → month-accurate reporting), clears it when OFF. No timeline
// note — the flag + sam_split_at are the record (Rob: don't clutter Comments with on/off).
export async function setSamSplit(id: string, value: boolean, actor: string | null): Promise<Deal> {
  void actor;
  const update = { sam_split: value, sam_split_at: value ? new Date().toISOString() : null };
  const { data, error } = await getDb().from(DEALS).update(update).eq("id", id).select("*").single();
  if (error) throw new Error(`setSamSplit: ${error.message}`);
  return data as Deal;
}

export async function addActivity(deal_id: string, a: { user_email: string | null; kind: string; body: string | null; meta: Record<string, unknown> | null }): Promise<Activity | null> {
  const { data, error } = await getDb().from(ACTIVITY).insert({ deal_id, ...a }).select("*").single();
  if (error) return null; // best-effort — a missing activity never blocks the deal
  return data as Activity;
}

export async function listActivity(deal_id: string): Promise<Activity[]> {
  const { data, error } = await getDb().from(ACTIVITY).select("*").eq("deal_id", deal_id).order("created_at", { ascending: true });
  if (error) return [];
  return (data as Activity[]) || [];
}

// PostgREST in-list of string values that may contain special chars (RFC msg-ids have
// <>@.) — quote each and escape embedded quotes.
function inList(vals: string[]): string {
  return `(${vals.map((v) => `"${String(v).replace(/"/g, '\\"')}"`).join(",")})`;
}

export async function upsertDealEmails(deal_id: string, rows: Omit<DealEmail, "id" | "deal_id" | "ingested_at">[]): Promise<number> {
  if (!rows.length) return 0;
  const payload = rows.map((r) => ({ deal_id, ...r }));
  // Per-MESSAGE upsert (one row per email). Pre-migration (no msg_id column/index) →
  // fall back to the old newest-per-thread collapse so it still works.
  let { error, count } = await getDb().from(EMAILS).upsert(payload, { onConflict: "deal_id,msg_id", count: "exact" });
  if (error && /msg_id|column|constraint|on conflict/i.test(error.message)) {
    const byThread = new Map<string, Omit<DealEmail, "id" | "deal_id" | "ingested_at">>();
    for (const r of rows) {
      const prev = byThread.get(r.thread_id);
      if (!prev || (r.msg_date || "") >= (prev.msg_date || "")) byThread.set(r.thread_id, r);
    }
    const collapsed = [...byThread.values()].map(({ msg_id: _m, ...rest }) => ({ deal_id, ...rest }));
    ({ error, count } = await getDb().from(EMAILS).upsert(collapsed, { onConflict: "deal_id,thread_id", count: "exact" }));
  }
  if (error) throw new Error(`upsertDealEmails: ${error.message}`);
  return count ?? rows.length;
}

// Authoritative sync: upsert the fresh (already-filtered) set, then delete any stale rows
// no longer matched — so a re-pull PRUNES previously-ingested noise. Prunes by msg_id when
// available (per-message), else by thread_id (pre-migration). Best-effort; never wipes on
// a transient empty search.
export async function replaceDealEmails(deal_id: string, rows: Omit<DealEmail, "id" | "deal_id" | "ingested_at">[]): Promise<number> {
  if (!rows.length) return 0;
  const n = await upsertDealEmails(deal_id, rows);
  const db = getDb();
  const msgIds = rows.map((r) => r.msg_id).filter(Boolean) as string[];

  // Prefer per-message pruning (msg_id): delete rows not in the fresh set…
  if (msgIds.length) {
    const r1 = await db.from(EMAILS).delete().eq("deal_id", deal_id).not("msg_id", "in", inList(msgIds));
    if (!r1.error) {
      // …AND clear pre-migration leftovers (NULL msg_id — e.g. the old NameJet / notification
      // rows), which `NOT IN` skips because NULL comparisons aren't TRUE.
      try { await db.from(EMAILS).delete().eq("deal_id", deal_id).is("msg_id", null); } catch { /* best-effort */ }
      return n;
    }
    // msg_id column not there yet → fall through to thread-based pruning.
  }

  // Pre-migration: prune whole stale THREADS (removes noise ingested before the filters).
  const threadIds = rows.map((r) => r.thread_id).filter(Boolean);
  if (threadIds.length) {
    try { await db.from(EMAILS).delete().eq("deal_id", deal_id).not("thread_id", "in", inList(threadIds)); }
    catch { /* best-effort — re-pull still refreshes */ }
  }
  return n;
}

export async function listDealEmails(deal_id: string): Promise<DealEmail[]> {
  const { data, error } = await getDb().from(EMAILS).select("*").eq("deal_id", deal_id).order("msg_date", { ascending: false });
  if (error) return [];
  return (data as DealEmail[]) || [];
}

// Board summary — count + pipeline value (asking, else appraisal) per open deal.
export async function boardStats(deals: Deal[]): Promise<{ open: number; pipelineValue: number; byStage: Record<string, number> }> {
  const open = deals.filter((d) => d.status === "open");
  const pipelineValue = open.reduce((sum, d) => sum + (d.asking_price || d.appraisal_value || 0), 0);
  const byStage: Record<string, number> = {};
  for (const d of open) byStage[d.stage] = (byStage[d.stage] || 0) + 1;
  return { open: open.length, pipelineValue, byStage };
}
