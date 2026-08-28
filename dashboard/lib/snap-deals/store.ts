// SNAP Deals persistence — the lean internal acquisition tracker. One row per deal in the
// shared main project (admin SUPABASE_URL); the service key bypasses RLS. All reads/writes
// go through here so the API + board + detail stay consistent. Fail-soft: if the table
// isn't there yet (scripts/snap_deals.sql not run), reads return [] and the board shows a
// "not set up" note rather than erroring.

import { getDb, isDbConfigured } from "../supabase";
import { ENTRY_STAGE, isValidStage, isValidStatus, type Stage, type Status } from "./stages";

const DEALS = "snap_deals";
const ACTIVITY = "snap_deal_activity";

export type SnapDeal = {
  id: string;
  domain: string;
  point_person: string | null;
  owner_info: string | null;
  asking_price: number | null;
  current_offer: number | null;
  priority: string | null;
  stage: string;
  status: string;
  drop_reason: string | null;
  notes: string | null;
  position: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SnapActivity = {
  id: string;
  deal_id: string;
  user_email: string | null;
  kind: string;
  body: string | null;
  created_at: string;
};

export function snapDealsConfigured(): boolean {
  return isDbConfigured();
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export async function listSnapDeals(opts: { status?: string; q?: string } = {}): Promise<SnapDeal[]> {
  if (!isDbConfigured()) return [];
  let query = getDb().from(DEALS).select("*");
  if (opts.status && opts.status !== "all") query = query.eq("status", opts.status);
  if (opts.q) query = query.ilike("domain", `%${opts.q}%`);
  const { data, error } = await query.order("position", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false });
  if (error) { if (missingTable(error)) return []; throw error; }
  return (data || []) as SnapDeal[];
}

export async function getSnapDeal(id: string): Promise<SnapDeal | null> {
  if (!isDbConfigured()) return null;
  const { data, error } = await getDb().from(DEALS).select("*").eq("id", id).maybeSingle();
  if (error) { if (missingTable(error)) return null; throw error; }
  return (data as SnapDeal) || null;
}

export type CreateSnapDealInput = {
  domain: string;
  pointPerson?: string;
  ownerInfo?: string;
  askingPrice?: number | string;
  currentOffer?: number | string;
  priority?: string;
  stage?: string;
  notes?: string;
  createdBy?: string;
};

export async function createSnapDeal(input: CreateSnapDealInput): Promise<SnapDeal> {
  const db = getDb();
  const domain = String(input.domain || "").trim().toLowerCase();
  if (!domain) throw new Error("domain is required");
  const row = {
    domain,
    point_person: str(input.pointPerson),
    owner_info: str(input.ownerInfo),
    asking_price: num(input.askingPrice),
    current_offer: num(input.currentOffer),
    priority: str(input.priority),
    stage: isValidStage(input.stage) ? input.stage : ENTRY_STAGE,
    status: "open" as Status,
    notes: str(input.notes),
    created_by: str(input.createdBy),
  };
  const { data, error } = await db.from(DEALS).insert(row).select("*").single();
  if (error) throw error;
  const deal = data as SnapDeal;
  await addSnapActivity(deal.id, { user_email: row.created_by, kind: "created", body: `Added to the board in ${deal.stage}` }).catch(() => {});
  return deal;
}

// Only these fields are user-editable. `stage`/`status` are validated + auto-logged.
const EDITABLE = new Set(["domain", "point_person", "owner_info", "asking_price", "current_offer", "priority", "notes"]);

export type UpdateSnapDealInput = Record<string, unknown> & { actor?: string };

export async function updateSnapDeal(id: string, patch: UpdateSnapDealInput): Promise<SnapDeal> {
  const db = getDb();
  const before = await getSnapDeal(id);
  if (!before) throw new Error("deal not found");
  const actor = str(patch.actor) || null;
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };

  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue;
    if (k === "asking_price" || k === "current_offer") upd[k] = num(v);
    else if (k === "domain") { const d = String(v || "").trim().toLowerCase(); if (d) upd[k] = d; }
    else upd[k] = str(v);
  }

  let stageChanged: string | null = null;
  if ("stage" in patch && isValidStage(patch.stage) && patch.stage !== before.stage) {
    upd.stage = patch.stage;
    stageChanged = patch.stage;
    // Reaching the Won column marks the deal won; moving back out of it reopens.
    if (patch.stage === "Closed - Won") upd.status = "won";
    else if (before.status === "won") upd.status = "open";
  }

  let statusChanged: string | null = null;
  if ("status" in patch && isValidStatus(patch.status) && patch.status !== before.status) {
    upd.status = patch.status;
    statusChanged = patch.status;
    upd.drop_reason = patch.status === "dropped" ? (str(patch.drop_reason) || null) : null;
  }

  const { data, error } = await db.from(DEALS).update(upd).eq("id", id).select("*").single();
  if (error) throw error;
  const after = data as SnapDeal;

  if (stageChanged) await addSnapActivity(id, { user_email: actor, kind: "stage_change", body: `${before.stage} → ${stageChanged}` }).catch(() => {});
  if (statusChanged) await addSnapActivity(id, { user_email: actor, kind: "status_change", body: statusChanged === "dropped" ? `Dropped${upd.drop_reason ? ` — ${upd.drop_reason}` : ""}` : statusChanged === "won" ? "Marked Won" : "Reopened" }).catch(() => {});
  return after;
}

export async function deleteSnapDeal(id: string): Promise<void> {
  const { error } = await getDb().from(DEALS).delete().eq("id", id);
  if (error) throw error;
}

export async function reorderSnapDeal(id: string, position: number): Promise<void> {
  await getDb().from(DEALS).update({ position }).eq("id", id);
}

export async function addSnapActivity(dealId: string, a: { user_email?: string | null; kind: string; body?: string | null }): Promise<void> {
  if (!isDbConfigured()) return;
  const { error } = await getDb().from(ACTIVITY).insert({ deal_id: dealId, user_email: a.user_email || null, kind: a.kind, body: a.body || null });
  if (error && !missingTable(error)) throw error;
}

export async function listSnapActivity(dealId: string): Promise<SnapActivity[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().from(ACTIVITY).select("*").eq("deal_id", dealId).order("created_at", { ascending: true });
  if (error) { if (missingTable(error)) return []; throw error; }
  return (data || []) as SnapActivity[];
}

export function boardStats(deals: SnapDeal[]): { open: number; byStage: Record<string, number> } {
  const open = deals.filter((d) => d.status === "open").length;
  const byStage: Record<string, number> = {};
  for (const d of deals) byStage[d.stage] = (byStage[d.stage] || 0) + 1;
  return { open, byStage };
}

// A missing table / undefined column (migration not run yet) — Postgres 42P01 / PGRST205.
function missingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code || "";
  const msg = (e?.message || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table");
}
