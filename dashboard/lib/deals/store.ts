// Deals persistence — our native buy-side CRM (Pipedrive replaced). One row per deal in
// the shared main project (admin SUPABASE_URL). The service key bypasses RLS. All reads/
// writes go through here so the API + board + detail stay consistent.

import { getDb, isDbConfigured } from "../supabase";
import { entryStage, type Stage, type Status } from "./stages";

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
  asking_price: number | null;
  source: string | null;
  priority: string | null;
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
  source?: string;
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
    budget_range: norm(input.budgetRange),
    appraisal_value: input.appraisalValue ?? null,
    asking_price: input.askingPrice ?? null,
    source: norm(input.source),
    priority: norm(input.priority),
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
  const ins = await getDb().from(DEALS).insert(row).select("*").single();
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

// Owner-scoped list. `all` (from the deals.all permission) returns everything; otherwise
// a user sees their OWN deals plus the unassigned Inbox (so they can claim from it).
export async function listDeals(opts: { all: boolean; me: string; status?: string; q?: string } = { all: true, me: "" }): Promise<Deal[]> {
  let query = getDb().from(DEALS).select("*").order("stage").order("position");
  if (opts.status) query = query.eq("status", opts.status);
  if (opts.q) query = query.or(`domain.ilike.%${opts.q}%,buyer_name.ilike.%${opts.q}%,buyer_email.ilike.%${opts.q}%,org_name.ilike.%${opts.q}%`);
  if (!opts.all && opts.me) query = query.or(`owner_email.eq.${opts.me.toLowerCase()},owner_email.is.null`);
  const { data, error } = await query;
  if (error) throw new Error(`listDeals: ${error.message}`);
  return (data as Deal[]) || [];
}

export async function getDeal(id: string): Promise<Deal | null> {
  const { data, error } = await getDb().from(DEALS).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getDeal: ${error.message}`);
  return (data as Deal) || null;
}

// Patch mutable fields. Records a field_change / stage_change / status_change / assignment
// activity for the meaningful ones. `actor` is the acting user's email.
export async function updateDeal(id: string, patch: Record<string, unknown>, actor: string | null): Promise<Deal> {
  const before = await getDeal(id);
  if (!before) throw new Error("deal not found");
  const update = { ...patch, updated_at: new Date().toISOString() };
  const { data, error } = await getDb().from(DEALS).update(update).eq("id", id).select("*").single();
  if (error) throw new Error(`updateDeal: ${error.message}`);
  const after = data as Deal;

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

export async function upsertDealEmails(deal_id: string, rows: Omit<DealEmail, "id" | "deal_id" | "ingested_at">[]): Promise<number> {
  if (!rows.length) return 0;
  const payload = rows.map((r) => ({ deal_id, ...r }));
  const { error, count } = await getDb().from(EMAILS).upsert(payload, { onConflict: "deal_id,thread_id", count: "exact" });
  if (error) throw new Error(`upsertDealEmails: ${error.message}`);
  return count ?? rows.length;
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
