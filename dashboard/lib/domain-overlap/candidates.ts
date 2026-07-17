// Candidate discovery for the overlap matcher: every domain newly seen since a given
// date across the marketplace/pipeline feeds. name_universe.first_seen is the
// authoritative "new since" key (afternic, atom, sedo, namecheap, namepros, …), so a
// freshly-listed name (the Howie.co-via-Afternic case) shows up here the day it lands.

import { getNamingDb, isNamingConfigured } from "../naming";
import type { Candidate } from "./match";

const PAGE = 1000;
const MAX = 40000; // safety cap on a single day's firehose

export async function readNewCandidates(since: string): Promise<Candidate[]> {
  if (!isNamingConfigured()) return [];
  const db = getNamingDb();
  const out: Candidate[] = [];
  for (let from = 0; from < MAX; from += PAGE) {
    const { data, error } = await db
      .from("name_universe")
      .select("domain,sld,tld,sources,best_price,best_price_source")
      .gte("first_seen", since)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`candidates: ${error.message || error.code || "failed"}`);
    const rows = data ?? [];
    for (const r of rows) {
      const row = r as { domain?: unknown; sld?: unknown; tld?: unknown; sources?: unknown; best_price?: unknown; best_price_source?: unknown };
      const domain = String(row.domain || "").toLowerCase();
      if (!domain) continue;
      const sources = Array.isArray(row.sources) ? (row.sources as string[]) : [];
      out.push({
        domain,
        sld: String(row.sld || domain.split(".")[0] || "").toLowerCase(),
        tld: String(row.tld || domain.split(".").slice(1).join(".") || "").toLowerCase(),
        feed: sources.length ? sources.join(",") : null,
        price: typeof row.best_price === "number" ? row.best_price : null,
        priceSource: row.best_price_source != null ? String(row.best_price_source) : null,
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Backfill candidates: every name_universe row whose SLD is one of the corpus SLDs,
 * regardless of when it was first seen. This is how STANDING overlaps surface (the
 * daily first_seen window only catches names listed today). Querying by `sld` is
 * indexed + fast (verified), so this stays cheap even though name_universe is huge.
 */
export async function readCandidatesBySld(slds: string[]): Promise<Candidate[]> {
  if (!isNamingConfigured()) return [];
  const uniq = [...new Set(slds.map((s) => s.toLowerCase()).filter(Boolean))];
  if (!uniq.length) return [];
  const db = getNamingDb();
  const CHUNK = 250; // IN(...) list size (well under URL limits)
  const POOL = 8; // concurrent chunk queries (T2 pushes this to ~500+ chunks)

  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) chunks.push(uniq.slice(i, i + CHUNK));

  const out: Candidate[] = [];
  async function fetchChunk(chunk: string[]): Promise<void> {
    const { data, error } = await db
      .from("name_universe")
      .select("domain,sld,tld,sources,best_price,best_price_source")
      .in("sld", chunk)
      .limit(5000);
    if (error) throw new Error(`backfill candidates: ${error.message || error.code || "failed"}`);
    for (const r of data ?? []) {
      const row = r as { domain?: unknown; sld?: unknown; tld?: unknown; sources?: unknown; best_price?: unknown; best_price_source?: unknown };
      const domain = String(row.domain || "").toLowerCase();
      if (!domain) continue;
      const sources = Array.isArray(row.sources) ? (row.sources as string[]) : [];
      out.push({
        domain,
        sld: String(row.sld || domain.split(".")[0] || "").toLowerCase(),
        tld: String(row.tld || domain.split(".").slice(1).join(".") || "").toLowerCase(),
        feed: sources.length ? sources.join(",") : null,
        price: typeof row.best_price === "number" ? row.best_price : null,
        priceSource: row.best_price_source != null ? String(row.best_price_source) : null,
      });
    }
  }

  // Bounded-concurrency pool over the chunks.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < chunks.length) {
      const idx = cursor++;
      await fetchChunk(chunks[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(POOL, chunks.length) }, () => worker()));
  return out;
}

/**
 * Which of these SLDs are common dictionary words (the noise guard). Batched lookup
 * against the naming project's english_words table; fail-open to an empty set so a
 * missing table just means length-only guarding.
 */
export async function dictionaryWords(slds: string[]): Promise<Set<string>> {
  const set = new Set<string>();
  const uniq = [...new Set(slds.map((s) => s.toLowerCase()).filter((s) => s.length > 3))];
  if (!uniq.length || !isNamingConfigured()) return set;
  const db = getNamingDb();
  try {
    for (let i = 0; i < uniq.length; i += 200) {
      const chunk = uniq.slice(i, i + 200);
      const { data, error } = await db.from("english_words").select("word").in("word", chunk);
      if (error) break; // table absent / not readable — fail-open
      for (const r of data ?? []) {
        const w = String((r as { word?: unknown }).word || "").toLowerCase();
        if (w) set.add(w);
      }
    }
  } catch {
    /* fail-open */
  }
  return set;
}
