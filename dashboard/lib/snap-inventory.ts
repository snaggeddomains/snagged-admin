// Persisted snapshot of the registrar-account inventory + the per-domain "hide from
// audit" overlay, for SNAP Names verification. A rebuild (lib/registrar/inventory.ts)
// is a burst of paginated registrar API calls, so the result is cached in Supabase
// (admin project) and read back cheaply on every page view; a rebuild is explicit.
// Fail-open: no table / no DB → the report still works, just unverified.
//
// One-time migration: scripts/snap_registrar_inventory.sql

import { getDb, isDbConfigured } from "./supabase";
import { listAllInventory, ownershipMap, type OwnedAt } from "./registrar/inventory";
import { computeNewUntracked, alertNewUntracked, type NewUntracked } from "./snap-alerts";

const SNAP_TABLE = "snap_registrar_inventory";
const HIDE_TABLE = "snap_inventory_hidden";

export interface AccountStatus {
  provider: string;
  label: string;
  account: string;
  ok: boolean;
  error?: string | null;
  count: number;
  capped?: boolean;
}
export interface InventorySnapshot {
  built_at: string;
  built_by: string | null;
  accounts: AccountStatus[];
  owned: Record<string, OwnedAt>; // domain → the account it's held in
  new_untracked?: NewUntracked[]; // names that first appeared this build and aren't on the sheet
}

// Read the current cached snapshot (null if never built / DB absent).
export async function readSnapshot(): Promise<InventorySnapshot | null> {
  if (!isDbConfigured()) return null;
  try {
    const { data } = await getDb().from(SNAP_TABLE).select("built_at, built_by, accounts, owned, new_untracked").eq("id", "current").maybeSingle();
    if (!data) return null;
    return {
      built_at: data.built_at,
      built_by: data.built_by ?? null,
      accounts: (data.accounts as AccountStatus[]) || [],
      owned: (data.owned as Record<string, OwnedAt>) || {},
      new_untracked: (data.new_untracked as NewUntracked[]) || [],
    };
  } catch {
    return null;
  }
}

// Rebuild the inventory live and persist it. Throws on a genuine write failure so the
// caller can surface "run the migration".
export async function buildAndSaveSnapshot(env: NodeJS.ProcessEnv, by: string | null): Promise<InventorySnapshot> {
  // Snapshot the PRIOR state first so we can diff for newly-acquired names.
  const prev = await readSnapshot();
  const inv = await listAllInventory(env);
  const owned = ownershipMap(inv);
  const accounts: AccountStatus[] = inv.map((a) => ({
    provider: a.provider, label: a.label, account: a.account, ok: a.ok, error: a.error ?? null, count: a.domains.length, capped: a.capped,
  }));

  // Names that first appeared in an account this build AND aren't on the SNAP sheet.
  const hiddenSet = new Set((await listHidden().catch(() => [])).map((h) => h.domain));
  let newUntracked: NewUntracked[] = [];
  try {
    newUntracked = await computeNewUntracked(prev?.owned, prev?.accounts, owned, hiddenSet);
  } catch {
    newUntracked = [];
  }

  const snapshot: InventorySnapshot = { built_at: new Date().toISOString(), built_by: by, accounts, owned, new_untracked: newUntracked };
  if (isDbConfigured()) {
    const row: Record<string, unknown> = { id: "current", built_at: snapshot.built_at, built_by: by, accounts, owned, new_untracked: newUntracked };
    let { error } = await getDb().from(SNAP_TABLE).upsert(row);
    // Degrade gracefully if the new_untracked column hasn't been added yet.
    if (error && /new_untracked|42703|column|schema cache|PGRST204/i.test(error.message)) {
      delete row.new_untracked;
      ({ error } = await getDb().from(SNAP_TABLE).upsert(row));
    }
    if (error) throw new Error(error.message);
  }
  // Push the bell + email AFTER persisting (so a notify failure never loses the snapshot).
  if (newUntracked.length) await alertNewUntracked(newUntracked, env).catch(() => {});
  return snapshot;
}

// ── audit resolve/hide overlay (with a reason tag) ───────────────────────────
export interface HiddenRow { domain: string; tag: string | null }
export async function listHidden(): Promise<HiddenRow[]> {
  if (!isDbConfigured()) return [];
  try {
    // Prefer domain+tag; fall back to domain-only if the tag column isn't there yet.
    const withTag = await getDb().from(HIDE_TABLE).select("domain, tag");
    const res = withTag.error ? await getDb().from(HIDE_TABLE).select("domain") : withTag;
    const rows = (res.data || []) as { domain?: string; tag?: string | null }[];
    return rows
      .map((r) => ({ domain: String(r.domain || "").toLowerCase(), tag: r.tag ?? null }))
      .filter((r) => r.domain);
  } catch {
    return [];
  }
}
export async function setHidden(domain: string, hidden: boolean, by: string | null, tag?: string | null): Promise<void> {
  const d = domain.trim().toLowerCase();
  if (!d) return;
  if (hidden) {
    const t = (tag || "").trim() || null;
    const row: Record<string, unknown> = { domain: d, tag: t, hidden_by: by, hidden_at: new Date().toISOString() };
    let { error } = await getDb().from(HIDE_TABLE).upsert(row);
    // Degrade gracefully if the tag column hasn't been added yet.
    if (error && /tag|42703|column/i.test(error.message)) {
      delete row.tag;
      ({ error } = await getDb().from(HIDE_TABLE).upsert(row));
    }
    if (error) throw new Error(error.message);
  } else {
    const { error } = await getDb().from(HIDE_TABLE).delete().eq("domain", d);
    if (error) throw new Error(error.message);
  }
}
