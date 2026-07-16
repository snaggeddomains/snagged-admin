// Persistence for the Client Domain corpus (client_domains + client_domain_build_runs,
// MAIN admin project via getDb()). The table is the SOURCE OF TRUTH; build.ts mirrors
// it to the Google Sheet after writing here.

import { getDb, isDbConfigured } from "../supabase";
import type { CorpusRow, ExistingMeta } from "./types";

const TABLE = "client_domains";
const RUNS = "client_domain_build_runs";
const PAGE = 1000;

/** Map of existing domain → {date_added, first_ingested_at} for continuity across rebuilds. */
export async function readExistingMeta(): Promise<Map<string, ExistingMeta>> {
  const out = new Map<string, ExistingMeta>();
  if (!isDbConfigured()) return out;
  const db = getDb();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE)
      .select("domain,date_added,first_ingested_at")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`corpus read: ${error.message || error.code || "failed"}`);
    const rows = data ?? [];
    for (const r of rows) {
      const row = r as { domain?: unknown; date_added?: unknown; first_ingested_at?: unknown };
      const d = String(row.domain || "").toLowerCase();
      if (!d || !row.date_added) continue;
      out.set(d, {
        date_added: String(row.date_added).slice(0, 10),
        first_ingested_at: row.first_ingested_at ? String(row.first_ingested_at).slice(0, 10) : null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Upsert the full corpus (chunked). Returns the number of rows written. */
export async function upsertCorpus(rows: CorpusRow[]): Promise<number> {
  if (!isDbConfigured() || !rows.length) return 0;
  const db = getDb();
  const now = new Date().toISOString();
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, updated_at: now }));
    const { error } = await db.from(TABLE).upsert(chunk, { onConflict: "domain" });
    if (error) throw new Error(`corpus upsert: ${error.message || error.code || "failed"}`);
    written += chunk.length;
  }
  return written;
}

export type MirrorRow = { domain: string; clients: string[]; last_contact_date: string | null; date_added: string; notes: string | null };

/** The FULL corpus for the Google Sheet mirror (incremental Gmail means a single
 *  run's rows are partial — the sheet must reflect the whole table). */
export async function readAllForMirror(): Promise<MirrorRow[]> {
  const out: MirrorRow[] = [];
  if (!isDbConfigured()) return out;
  const db = getDb();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(TABLE)
      .select("domain,clients,last_contact_date,date_added,notes")
      .order("domain", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`corpus mirror read: ${error.message || error.code || "failed"}`);
    const rows = data ?? [];
    for (const r of rows) {
      const row = r as { domain?: unknown; clients?: unknown; last_contact_date?: unknown; date_added?: unknown; notes?: unknown };
      out.push({
        domain: String(row.domain || ""),
        clients: Array.isArray(row.clients) ? (row.clients as string[]) : [],
        last_contact_date: row.last_contact_date ? String(row.last_contact_date).slice(0, 10) : null,
        date_added: row.date_added ? String(row.date_added).slice(0, 10) : "",
        notes: row.notes != null ? String(row.notes) : null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Current row count — powers the freshness guard + the tab's "total" figure. */
export async function corpusCount(): Promise<number> {
  if (!isDbConfigured()) return 0;
  const { count, error } = await getDb().from(TABLE).select("domain", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

export type BuildRun = {
  run_at: string;
  run_date: string;
  added_count: number;
  total_count: number;
  source_counts: Record<string, number>;
  gmail_days: number | null;
  ok: boolean;
  error: string | null;
};

/** Record one build run (best-effort — never throws; a failed log shouldn't fail the build). */
export async function logBuildRun(run: Omit<BuildRun, "run_at">): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await getDb().from(RUNS).insert({ ...run, run_at: new Date().toISOString() });
  } catch {
    /* best-effort */
  }
}

/** Recent build runs (newest first) for the history strip + green-dot freshness. */
export async function recentBuildRuns(limit = 30): Promise<BuildRun[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from(RUNS)
    .select("run_at,run_date,added_count,total_count,source_counts,gmail_days,ok,error")
    .order("run_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as BuildRun[];
}

/** The actual domains first ingested on a given date (the drill-down). */
export async function domainsAddedOn(date: string): Promise<{ domain: string; clients: string[]; sources: string[] }[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from(TABLE)
    .select("domain,clients,sources")
    .eq("first_ingested_at", date)
    .order("domain", { ascending: true })
    .limit(5000);
  if (error) return [];
  return (data ?? []).map((r) => {
    const row = r as { domain?: unknown; clients?: unknown; sources?: unknown };
    return {
      domain: String(row.domain || ""),
      clients: Array.isArray(row.clients) ? (row.clients as string[]) : [],
      sources: Array.isArray(row.sources) ? (row.sources as string[]) : [],
    };
  });
}
