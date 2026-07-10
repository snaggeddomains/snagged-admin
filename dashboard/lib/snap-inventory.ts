// Persisted snapshot of the registrar-account inventory + the per-domain "hide from
// audit" overlay, for SNAP Names verification. A rebuild (lib/registrar/inventory.ts)
// is a burst of paginated registrar API calls, so the result is cached in Supabase
// (admin project) and read back cheaply on every page view; a rebuild is explicit.
// Fail-open: no table / no DB → the report still works, just unverified.
//
// One-time migration: scripts/snap_registrar_inventory.sql

import { getDb, isDbConfigured } from "./supabase";
import { listAllInventory, ownershipMap, type OwnedAt } from "./registrar/inventory";

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
}

// Read the current cached snapshot (null if never built / DB absent).
export async function readSnapshot(): Promise<InventorySnapshot | null> {
  if (!isDbConfigured()) return null;
  try {
    const { data } = await getDb().from(SNAP_TABLE).select("built_at, built_by, accounts, owned").eq("id", "current").maybeSingle();
    if (!data) return null;
    return {
      built_at: data.built_at,
      built_by: data.built_by ?? null,
      accounts: (data.accounts as AccountStatus[]) || [],
      owned: (data.owned as Record<string, OwnedAt>) || {},
    };
  } catch {
    return null;
  }
}

// Rebuild the inventory live and persist it. Throws on a genuine write failure so the
// caller can surface "run the migration".
export async function buildAndSaveSnapshot(env: NodeJS.ProcessEnv, by: string | null): Promise<InventorySnapshot> {
  const inv = await listAllInventory(env);
  const owned = ownershipMap(inv);
  const accounts: AccountStatus[] = inv.map((a) => ({
    provider: a.provider, label: a.label, account: a.account, ok: a.ok, error: a.error ?? null, count: a.domains.length, capped: a.capped,
  }));
  const snapshot: InventorySnapshot = { built_at: new Date().toISOString(), built_by: by, accounts, owned };
  if (isDbConfigured()) {
    const { error } = await getDb().from(SNAP_TABLE).upsert({
      id: "current", built_at: snapshot.built_at, built_by: by, accounts, owned,
    });
    if (error) throw new Error(error.message);
  }
  return snapshot;
}

// ── audit hide overlay ───────────────────────────────────────────────────────
export async function listHidden(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from(HIDE_TABLE).select("domain");
    return (data || []).map((r: { domain: string }) => String(r.domain || "").toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}
export async function setHidden(domain: string, hidden: boolean, by: string | null): Promise<void> {
  const d = domain.trim().toLowerCase();
  if (!d) return;
  if (hidden) {
    const { error } = await getDb().from(HIDE_TABLE).upsert({ domain: d, hidden_by: by, hidden_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await getDb().from(HIDE_TABLE).delete().eq("domain", d);
    if (error) throw new Error(error.message);
  }
}
