// Admin Imports — upsert domains into either corpus, merge or replace-by-source.
//
//   Universe (name_universe): upsert via the pipeline's upsert_universe_rows RPC
//     so sources[] merge + first_seen preservation stay consistent. Structural
//     fields (zipf/num_words/...) are left NULL and filled by the
//     `pipeline backfill-structural` job. TLD stored bare ('com').
//   Master Domain List: plain upsert on `domain`, single `source` column,
//     tagged with the import timestamp (updated_at) for replace.
//
// Replace mode removes the source's rows NOT refreshed by this import:
//   Master   — delete rows where source=<s> AND updated_at < importTs.
//   Universe — delete SOLE-source stragglers (sources = {<s>}) with last_seen <
//     today (multi-source domains keep the tag — a known v1 limitation).

import { getNamingDb } from "./naming";
import { getMasterlistDb } from "./masterlist";
import { getDb, isDbConfigured } from "./supabase";

const MASTER_TABLE = "Master Domain List";
const IMPORTS_TABLE = "domain_research_imports";

export type ImportRow = { domain: string; price?: number | null; owner?: string | null };
export type Target = "universe" | "master";

/** Normalize + split a domain into { domain, sld, tld(bare) }; null if invalid. */
export function splitDomain(raw: string): { domain: string; sld: string; tld: string } | null {
  const d = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const dot = d.indexOf(".");
  if (dot <= 0) return null;
  const sld = d.slice(0, dot);
  const tld = d.slice(dot + 1).replace(/^\.+/, ""); // bare, no leading dot
  if (!sld || !tld) return null;
  return { domain: d, sld, tld };
}

/** True for a Postgres statement-timeout (57014) / canceled statement. */
function isTimeout(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false;
  return err.code === "57014" || /statement timeout|canceling statement/i.test(err.message || "");
}

/** Upsert a batch of universe rows, halving on statement-timeout. The merge RPC
 *  over the ~6M-row table can blow the statement timeout on big batches; on a
 *  timeout we split and retry each half (down to a single row) so a large import
 *  still lands instead of failing the whole chunk. */
async function upsertUniverseChunk(wire: Record<string, unknown>[]): Promise<void> {
  if (!wire.length) return;
  const { error } = await getNamingDb().rpc("upsert_universe_rows", { rows: wire });
  if (!error) return;
  if (isTimeout(error) && wire.length > 1) {
    const mid = Math.floor(wire.length / 2);
    await upsertUniverseChunk(wire.slice(0, mid));
    await upsertUniverseChunk(wire.slice(mid));
    return;
  }
  throw new Error(`universe upsert: ${error.message}`);
}

/** Universe upsert via the merge RPC (consistent with the pipeline). */
export async function upsertUniverse(source: string, rows: ImportRow[], today: string): Promise<number> {
  const wire = [];
  for (const r of rows) {
    const s = splitDomain(r.domain);
    if (!s) continue;
    const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
    wire.push({
      domain: s.domain,
      sld: s.sld,
      tld: s.tld,
      sld_length: s.sld.length,
      observed_date: today,
      sources: [source],
      best_price: price,
      best_price_source: price != null ? source : null,
      source_tier: 2,
      zipf_score: null,
      num_words: null,
      num_syllables: null,
      is_dictionary_word: null,
      quality_score: null,
      deal_score: null,
    });
  }
  if (!wire.length) return 0;
  await upsertUniverseChunk(wire);
  return wire.length;
}

/** Upsert a batch of master rows, halving on statement-timeout (same rationale
 *  as the universe path — the ~435K-row table can time out on big batches). */
async function upsertMasterChunk(out: Record<string, unknown>[]): Promise<void> {
  if (!out.length) return;
  const { error } = await getMasterlistDb().from(MASTER_TABLE).upsert(out, { onConflict: "domain" });
  if (!error) return;
  if (isTimeout(error) && out.length > 1) {
    const mid = Math.floor(out.length / 2);
    await upsertMasterChunk(out.slice(0, mid));
    await upsertMasterChunk(out.slice(mid));
    return;
  }
  throw new Error(`master upsert: ${error.message}`);
}

/** Master upsert (single source), tagged with importTs for replace. */
export async function upsertMaster(source: string, rows: ImportRow[], importTs: string): Promise<number> {
  const out = [];
  for (const r of rows) {
    const s = splitDomain(r.domain);
    if (!s) continue;
    const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
    const owner = typeof r.owner === "string" && r.owner.trim() ? r.owner.trim() : null;
    out.push({
      domain: s.domain,
      tld: s.tld,
      sld_length: s.sld.length,
      source,
      price,
      owner,
      updated_at: importTs,
    });
  }
  if (!out.length) return 0;
  await upsertMasterChunk(out);
  return out.length;
}

/** Replace finalize: drop this source's rows not refreshed in this import. */
export async function finalizeReplace(
  target: Target,
  source: string,
  importTs: string,
  today: string,
): Promise<number> {
  if (target === "master") {
    const { error, count } = await getMasterlistDb()
      .from(MASTER_TABLE)
      .delete({ count: "estimated" })
      .eq("source", source)
      .lt("updated_at", importTs);
    if (error) throw new Error(`master replace: ${error.message}`);
    return count ?? 0;
  }
  // Universe: delete sole-source stragglers (sources == {source}) not seen today.
  const { error, count } = await getNamingDb()
    .from("name_universe")
    .delete({ count: "estimated" })
    .eq("sources", `{${source}}`)
    .lt("last_seen", today);
  if (error) throw new Error(`universe replace: ${error.message}`);
  return count ?? 0;
}

export type PreviewResult = {
  parsed: number; // valid (splittable) rows in the import
  invalid: number; // raw rows that failed to parse
  existing: number; // import domains already present in the target
  fresh: number; // import domains not yet present (net-new)
  removed: number; // rows replace mode would delete (0 in merge mode)
  sourceTotal: number; // rows currently tagged with this source in the target
};

/** Dry-run: count what an import would touch, without writing anything. */
export async function previewImport(
  target: Target,
  source: string,
  rows: ImportRow[],
  mode: "merge" | "replace",
): Promise<PreviewResult> {
  const seen = new Set<string>();
  let invalid = 0;
  for (const r of rows) {
    const s = splitDomain(r.domain);
    if (!s) {
      invalid++;
      continue;
    }
    seen.add(s.domain);
  }
  const domains = [...seen];
  const parsed = domains.length;

  // How many of the import's domains already exist in the target?
  const table = target === "master" ? MASTER_TABLE : "name_universe";
  const db = target === "master" ? getMasterlistDb() : getNamingDb();
  let existing = 0;
  const CHUNK = 500;
  for (let i = 0; i < domains.length; i += CHUNK) {
    const chunk = domains.slice(i, i + CHUNK);
    const { count, error } = await db
      .from(table)
      .select("domain", { count: "exact", head: true })
      .in("domain", chunk);
    if (error) throw new Error(`preview existing: ${error.message}`);
    existing += count ?? 0;
  }
  const fresh = parsed - existing;

  // How many rows currently carry this source (the replace-mode delete pool)?
  let sourceTotal = 0;
  if (target === "master") {
    const { count, error } = await getMasterlistDb()
      .from(MASTER_TABLE)
      .select("domain", { count: "exact", head: true })
      .eq("source", source);
    if (error) throw new Error(`preview source total: ${error.message}`);
    sourceTotal = count ?? 0;
  } else {
    const { count, error } = await getNamingDb()
      .from("name_universe")
      .select("domain", { count: "exact", head: true })
      .eq("sources", `{${source}}`);
    if (error) throw new Error(`preview source total: ${error.message}`);
    sourceTotal = count ?? 0;
  }
  // Replace deletes the source rows this import does NOT refresh; cap at >= 0.
  const removed = mode === "replace" ? Math.max(0, sourceTotal - existing) : 0;

  return { parsed, invalid, existing, fresh, removed, sourceTotal };
}

/** Count how many of `domains` already exist in the target. Domains within an
 *  import are unique, so we can sub-chunk the .in() (which goes in the URL — too
 *  many values 414s) and sum without double-counting. */
export async function countExisting(target: Target, domains: string[]): Promise<number> {
  if (!domains.length) return 0;
  const table = target === "master" ? MASTER_TABLE : "name_universe";
  const db = target === "master" ? getMasterlistDb() : getNamingDb();
  const IN_CHUNK = 200; // keep the IN(...) URL well under length limits
  let total = 0;
  for (let i = 0; i < domains.length; i += IN_CHUNK) {
    const slice = domains.slice(i, i + IN_CHUNK);
    const { count, error } = await db
      .from(table)
      .select("domain", { count: "exact", head: true })
      .in("domain", slice);
    if (error) throw new Error(`count existing: ${error.message || error.code || "request failed"}`);
    total += count ?? 0;
  }
  return total;
}

/** Count rows currently tagged with `source` in the target (replace delete-pool). */
export async function countSourceRows(target: Target, source: string): Promise<number> {
  if (target === "master") {
    const { count, error } = await getMasterlistDb()
      .from(MASTER_TABLE)
      .select("domain", { count: "exact", head: true })
      .eq("source", source);
    if (error) throw new Error(`count source: ${error.message}`);
    return count ?? 0;
  }
  const { count, error } = await getNamingDb()
    .from("name_universe")
    .select("domain", { count: "exact", head: true })
    .eq("sources", `{${source}}`);
  if (error) throw new Error(`count source: ${error.message}`);
  return count ?? 0;
}

export type EnrichStatus = {
  eligible: number; // rows for this source with quality_score >= the enrich floor
  enriched: number; // of those, how many are LLM-enriched (category not null)
};

/** Live enrichment progress for a source: of the NET-NEW names from an import
 *  (created at/after `since`) that qualify (quality_score >= floor), how many
 *  are already enriched. Net-new mirrors the enrich selection — universe by
 *  first_seen (date), master by created_at — so pre-existing names are excluded. */
export async function enrichStatus(target: Target, source: string, floor = 1, since?: string): Promise<EnrichStatus> {
  const table = target === "master" ? MASTER_TABLE : "name_universe";
  const db = target === "master" ? getMasterlistDb() : getNamingDb();
  const scoped = () => {
    let q = db.from(table).select("domain", { count: "exact", head: true }).gte("quality_score", floor);
    q = target === "master" ? q.eq("source", source) : q.contains("sources", [source]);
    // Floor to the DATE (midnight): the import's rows are created slightly before
    // the log entry, so an exact-timestamp >= would wrongly exclude them.
    if (since) q = q.gte(target === "master" ? "created_at" : "first_seen", since.slice(0, 10));
    return q;
  };
  const { count: eligible, error: e1 } = await scoped();
  if (e1) throw new Error(`enrich status: ${e1.message || e1.code || "request failed"}`);
  const { count: enriched, error: e2 } = await scoped().not("category", "is", null);
  if (e2) throw new Error(`enrich status: ${e2.message || e2.code || "request failed"}`);
  return { eligible: eligible ?? 0, enriched: enriched ?? 0 };
}

export type ImportLogRow = {
  target: Target;
  source: string;
  mode: string;
  parsed: number;
  upserted: number;
  removed: number;
  backfilled?: boolean;
  import_ts?: string | null;
  user_email?: string | null;
};

/** Append a row to the import-history log (best-effort; never throws). */
export async function logImport(entry: ImportLogRow): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    const { error } = await getDb()
      .from(IMPORTS_TABLE)
      .insert({
        target: entry.target,
        source: entry.source,
        mode: entry.mode,
        parsed: entry.parsed,
        upserted: entry.upserted,
        removed: entry.removed,
        backfilled: entry.backfilled ?? false,
        import_ts: entry.import_ts ?? null,
        user_email: entry.user_email ?? null,
      });
    if (error) console.warn(`logImport: ${error.message}`);
  } catch (e) {
    console.warn(`logImport: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Read the most-recent import-history entries (newest first). */
export async function listImports(limit = 25): Promise<Record<string, unknown>[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from(IMPORTS_TABLE)
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listImports: ${error.message}`);
  return data ?? [];
}

/** Delete a single import-history entry (the trash control on a job card). The
 *  log is a record of past runs only — removing a row never touches corpus data. */
export async function deleteImport(id: string): Promise<void> {
  if (!isDbConfigured() || !id) return;
  const { error } = await getDb().from(IMPORTS_TABLE).delete().eq("id", id);
  if (error) throw new Error(`deleteImport: ${error.message}`);
}

/** Distinct source names ever used by an import, tagged by target (cheap — from
 *  the log, not the corpora). Feeds the source-name typeahead. */
export async function listImportSources(): Promise<{ source: string; target: string }[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from(IMPORTS_TABLE)
    .select("source, target")
    .limit(2000);
  if (error) return [];
  const out: { source: string; target: string }[] = [];
  for (const r of data ?? []) {
    const row = r as { source?: unknown; target?: unknown };
    const s = String(row.source || "").trim();
    if (s) out.push({ source: s, target: String(row.target || "") });
  }
  return out;
}

/** Distinct `source` values actually present in the Master Domain List, via the
 *  distinct_master_sources() RPC (a full DISTINCT scan would be too heavy to do
 *  client-side over ~435K rows). Returns [] if the RPC isn't installed yet. */
export async function listMasterSources(): Promise<string[]> {
  try {
    const { data, error } = await getMasterlistDb().rpc("distinct_master_sources");
    if (error || !Array.isArray(data)) return [];
    const set = new Set<string>();
    for (const r of data) {
      // RPC returns table(source text) → [{ source }]; tolerate scalar rows too.
      const s = String((r as { source?: unknown })?.source ?? r ?? "").trim();
      if (s) set.add(s);
    }
    return [...set];
  } catch {
    return [];
  }
}
