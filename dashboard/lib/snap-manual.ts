// Manually-added SNAP names — domains we hold in a registrar account but that aren't
// on either owner spreadsheet. Stored as a small overlay (admin project) and merged
// into the report by buildSnapNames, so a name can be added to the list from the
// verification audit without editing the sheets. Fail-open: no table → [].

import { getDb, isDbConfigured } from "./supabase";
import type { SnapSource } from "./snap-names";

const TABLE = "snap_names_manual";
const SOURCES: SnapSource[] = ["Berserk", "SNAP", "Rob"];
const coerceSource = (s: unknown): SnapSource => (SOURCES.includes(s as SnapSource) ? (s as SnapSource) : "SNAP");

export interface ManualRow { domain: string; source: SnapSource; owner: string | null }

export async function listManual(): Promise<ManualRow[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from(TABLE).select("domain, source, owner");
    return (data || [])
      .map((r: { domain?: string; source?: string; owner?: string | null }) => ({
        domain: String(r.domain || "").toLowerCase(),
        source: coerceSource(r.source),
        owner: r.owner ?? null,
      }))
      .filter((r) => r.domain.includes("."));
  } catch {
    return [];
  }
}

export async function addManual(domain: string, source: SnapSource, owner: string | null, by: string | null): Promise<void> {
  const d = domain.trim().toLowerCase();
  if (!d.includes(".")) throw new Error("Invalid domain");
  const { error } = await getDb().from(TABLE).upsert({ domain: d, source: coerceSource(source), owner: owner || null, added_by: by, added_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function removeManual(domain: string): Promise<void> {
  const d = domain.trim().toLowerCase();
  const { error } = await getDb().from(TABLE).delete().eq("domain", d);
  if (error) throw new Error(error.message);
}
