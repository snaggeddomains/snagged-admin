// Ahrefs Site Explorer API v3 — head-to-head domain metrics + organic keyword
// positions for the SEO report (search volume + our vs competitor rank, incl. terms
// GSC has no impressions for yet). Auth: Authorization: Bearer <AHREF_API_KEY>
// (also accepts AHREFS_API_KEY). Every call fail-open at the call site.
const BASE = "https://api.ahrefs.com/v3/site-explorer";

function apiKey(): string | null {
  return process.env.AHREF_API_KEY || process.env.AHREFS_API_KEY || null;
}
export function ahrefsConfigured(): boolean {
  return Boolean(apiKey());
}
// Ahrefs wants a concrete date; use ~2 days back to be safely inside indexed data.
const ahDate = () => new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : v ? Number(v) || 0 : 0);
const cents = (v: unknown) => Math.round(num(v)) / 100;
const bareDomain = (d: string) => d.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase();

async function ah(path: string, params: Record<string, string | number>): Promise<Record<string, unknown>> {
  const k = apiKey();
  if (!k) throw new Error("AHREF_API_KEY not set");
  const qs = new URLSearchParams(Object.entries(params).map(([a, b]) => [a, String(b)]));
  const res = await fetch(`${BASE}/${path}?${qs}`, { headers: { Authorization: `Bearer ${k}` } });
  if (!res.ok) throw new Error(`ahrefs ${path} ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return (await res.json()) as Record<string, unknown>;
}

export type AhrefsMetrics = { domain: string; dr: number | null; org_traffic: number; org_keywords: number; org_value_usd: number };
// Domain-level head-to-head numbers (DR + organic traffic/keywords/value).
export async function ahrefsMetrics(domain: string): Promise<AhrefsMetrics> {
  const target = bareDomain(domain);
  const date = ahDate();
  const out: AhrefsMetrics = { domain: target, dr: null, org_traffic: 0, org_keywords: 0, org_value_usd: 0 };
  try {
    const m = ((await ah("metrics", { target, date, mode: "subdomains" })).metrics || {}) as Record<string, unknown>;
    out.org_traffic = num(m.org_traffic);
    out.org_keywords = num(m.org_keywords);
    out.org_value_usd = cents(m.org_cost);
  } catch { /* fail-open */ }
  try {
    const d = ((await ah("domain-rating", { target, date })).domain_rating || {}) as Record<string, unknown>;
    out.dr = num(d.domain_rating);
  } catch { /* fail-open */ }
  return out;
}

export type AhrefsKw = { keyword: string; position: number; volume: number; url: string };
// Every organic keyword the domain ranks for (keyword → best position + volume),
// indexed by the caller to look up target-term positions + volume, and gap terms.
export async function ahrefsOrganicKeywords(domain: string, country = "us", limit = 2000): Promise<AhrefsKw[]> {
  const target = bareDomain(domain);
  const date = ahDate();
  const select = "keyword,best_position,volume,best_position_url";
  const rows = ((await ah("organic-keywords", { target, country, date, select, order_by: "volume:desc", limit, mode: "subdomains" })).keywords || []) as Record<string, unknown>[];
  return rows
    .map((r) => ({ keyword: String(r.keyword || "").toLowerCase().trim(), position: num(r.best_position), volume: num(r.volume), url: String(r.best_position_url || "") }))
    .filter((r) => r.keyword);
}

export type KwVolume = { keyword: string; volume: number; difficulty: number | null };
// Ahrefs Keywords Explorer — authoritative search VOLUME (+ difficulty) for ANY
// keyword, whether or not anyone ranks for it. This is the keyword-planner source.
// Metered separately from Site Explorer; fail-open (caller falls back to org-keyword
// volume). ⚠️ Verify the endpoint/field shapes on the first live run.
export async function ahrefsKeywordVolumes(keywords: string[], country = "us"): Promise<Map<string, KwVolume>> {
  const map = new Map<string, KwVolume>();
  const list = [...new Set(keywords.map((k) => k.toLowerCase().trim()).filter(Boolean))];
  if (!ahrefsConfigured() || !list.length) return map;
  try {
    const data = await ah("keywords-explorer/overview", { country, keywords: list.join(","), select: "keyword,volume,difficulty" });
    const rows = ((data.keywords || data.metrics || data.data || []) as Record<string, unknown>[]);
    for (const r of rows) {
      const kw = String(r.keyword || "").toLowerCase().trim();
      if (kw) map.set(kw, { keyword: kw, volume: num(r.volume), difficulty: r.difficulty != null ? num(r.difficulty) : null });
    }
  } catch { /* fail-open — caller uses organic-keyword volume instead */ }
  return map;
}

// Build a keyword → {position, volume, url} map for quick lookups (fail-open to empty).
export async function ahrefsKeywordMap(domain: string, country = "us"): Promise<Map<string, AhrefsKw>> {
  const map = new Map<string, AhrefsKw>();
  try {
    for (const kw of await ahrefsOrganicKeywords(domain, country)) {
      const prev = map.get(kw.keyword);
      if (!prev || kw.position < prev.position) map.set(kw.keyword, kw);
    }
  } catch { /* fail-open */ }
  return map;
}
