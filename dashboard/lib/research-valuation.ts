// Cross-app valuation: ask the RESEARCH app for each domain's Appraise.net value +
// TLD-demand count. The valuation keys (APPRAISE_NET_*, etc.) live only in research,
// so we call its internal endpoint with the shared secret instead of duplicating them
// here. Best-effort + fail-open → an empty map (the picks still render, just unvalued).
//
// Env: RESEARCH_INTERNAL_BASE (default https://research.snagged.com) + RESEARCH_INTERNAL_SECRET
// (already set here — it's the same secret research uses to call our internal endpoints).

export type Valuation = {
  appraisalMid: number | null;
  appraisalLow: number | null;
  appraisalHigh: number | null;
  tldCount: number | null;
  tldBand: string | null;
};

const BASE = (process.env.RESEARCH_INTERNAL_BASE || "https://research.snagged.com").replace(/\/+$/, "");

export function researchValuationConfigured(): boolean {
  return Boolean(process.env.RESEARCH_INTERNAL_SECRET);
}

export async function valuateDomains(domains: string[]): Promise<Map<string, Valuation>> {
  const out = new Map<string, Valuation>();
  const secret = process.env.RESEARCH_INTERNAL_SECRET;
  const list = [...new Set(domains.map((d) => String(d || "").trim().toLowerCase()).filter((d) => d.includes(".")))];
  if (!secret || !list.length) return out;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch(`${BASE}/api/internal/valuate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify({ domains: list }),
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return out;
    const data = (await res.json().catch(() => ({}))) as {
      results?: { domain: string; appraisal?: { mid?: number; low?: number; high?: number } | null; tld_count?: number | null; tld_band?: string | null }[];
    };
    for (const r of data.results || []) {
      const key = String(r.domain || "").toLowerCase();
      if (!key) continue;
      out.set(key, {
        appraisalMid: r.appraisal?.mid ?? null,
        appraisalLow: r.appraisal?.low ?? null,
        appraisalHigh: r.appraisal?.high ?? null,
        tldCount: r.tld_count ?? null,
        tldBand: r.tld_band ?? null,
      });
    }
  } catch {
    /* fail-open — empty map */
  } finally {
    clearTimeout(t);
  }
  return out;
}
