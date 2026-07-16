// DomainScout ingest (spec §2.5 / §15). Pulls the monitored-domain watchlist from
// the DomainScout API (same Sanctum Bearer token the research app uses, GET the
// paginated index at /api/v1/domains). Entirely fail-open: a missing key, a 403
// (needs the Hunter plan), or a bad response degrades to [] and never sinks the build.

import { canonicalApex } from "../canonical";
import { todayISO } from "../merge";
import type { RawHit } from "../types";

const BASE = "https://www.domainscout.io/api/v1/domains";
const MAX_PAGES = 50;

function apiKey(): string {
  return process.env.DOMAINSCOUT_KEY || process.env.DOMAINSCOUT_API_KEY || "";
}

export function domainScoutConfigured(): boolean {
  return Boolean(apiKey());
}

async function getPage(page: number): Promise<{ items: unknown[]; hasNext: boolean }> {
  const key = apiKey();
  const url = `${BASE}?page=${page}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json", "user-agent": "snagged-admin/1.0 (+https://snagged.com)" },
      signal: ctrl.signal,
    });
    if (!res.ok) return { items: [], hasNext: false };
    const j = (await res.json()) as { data?: unknown[]; links?: { next?: string | null }; meta?: { current_page?: number; last_page?: number } };
    const items = Array.isArray(j.data) ? j.data : Array.isArray(j as unknown[]) ? (j as unknown as unknown[]) : [];
    const hasNext = Boolean(j.links?.next) || (j.meta ? Number(j.meta.current_page) < Number(j.meta.last_page) : false);
    return { items, hasNext };
  } catch {
    return { items: [], hasNext: false };
  } finally {
    clearTimeout(t);
  }
}

export async function readDomainScoutHits(): Promise<RawHit[]> {
  if (!domainScoutConfigured()) return [];
  const hits: RawHit[] = [];
  const today = todayISO();
  const seen = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, hasNext } = await getPage(page);
    if (!items.length) break;
    for (const it of items) {
      const raw = it as Record<string, unknown>;
      const val = raw.domain ?? raw.name ?? raw.hostname ?? "";
      const apex = canonicalApex(String(val || ""));
      if (!apex || seen.has(apex)) continue;
      seen.add(apex);
      hits.push({ domain: apex, client: null, source: "[DomainScout]", note: `[DomainScout] Fetched:${today}`, date: today });
    }
    if (!hasNext) break;
  }
  return hits;
}
