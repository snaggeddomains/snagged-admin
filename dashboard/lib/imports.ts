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

const MASTER_TABLE = "Master Domain List";

export type ImportRow = { domain: string; price?: number | null };
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
  const { error } = await getNamingDb().rpc("upsert_universe_rows", { rows: wire });
  if (error) throw new Error(`universe upsert: ${error.message}`);
  return wire.length;
}

/** Master upsert (single source), tagged with importTs for replace. */
export async function upsertMaster(source: string, rows: ImportRow[], importTs: string): Promise<number> {
  const out = [];
  for (const r of rows) {
    const s = splitDomain(r.domain);
    if (!s) continue;
    const price = typeof r.price === "number" && isFinite(r.price) ? r.price : null;
    out.push({
      domain: s.domain,
      tld: s.tld,
      sld_length: s.sld.length,
      source,
      price,
      updated_at: importTs,
    });
  }
  if (!out.length) return 0;
  const { error } = await getMasterlistDb().from(MASTER_TABLE).upsert(out, { onConflict: "domain" });
  if (error) throw new Error(`master upsert: ${error.message}`);
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
