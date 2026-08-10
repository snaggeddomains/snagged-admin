// Builds the live SEO report and writes the weekly snapshot. Combines:
//   • GSC  — our real position / impressions / clicks / CTR per target term + top movers
//   • Ahrefs — search volume, our vs MediaOptions position (incl. terms GSC can't see)
//   • GA4  — organic sessions + conversions on the money pages
// plus week-over-week position deltas ("gaining/losing distance") from stored snapshots.
import { googleAccessToken } from "../google-auth";
import { runReport, gaConfigured } from "../ga";
import { ahrefsConfigured, ahrefsMetrics, ahrefsKeywordMap, type AhrefsMetrics } from "../ahrefs";
import {
  listTargets, listActions, snapshotsForWeek, snapshotWeeks, writeSnapshots, weekStart,
  type TargetKeyword, type Snapshot, type SeoAction,
} from "./store";

const GSC_SITE = process.env.GSC_SITE_URL || "https://www.snagged.com/";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const COMPETITOR = process.env.SEO_COMPETITOR_DOMAIN || "mediaoptions.com";
const OUR_DOMAIN = process.env.SEO_SITE_DOMAIN || "snagged.com";
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : v ? Number(v) || 0 : 0);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 864e5));
// RE2-escape a phrase for a GSC includingRegex filter.
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");

type GscRow = { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number };
async function gscQuery(body: Record<string, unknown>): Promise<GscRow[]> {
  const token = await googleAccessToken(SCOPE);
  const res = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GSC ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return ((await res.json()) as { rows?: GscRow[] }).rows || [];
}

// GSC metrics for one target term family (all queries containing the phrase),
// impression-weighted average position + the strongest variant/page.
type TermGsc = { position: number | null; impressions: number; clicks: number; ctr: number | null; top_variant: string; top_url: string };
async function gscTerm(keyword: string, from: string, to: string): Promise<TermGsc> {
  const flt = { dimension: "query", operator: "includingRegex", expression: reEsc(keyword.toLowerCase()) };
  const base = { startDate: from, endDate: to, dimensionFilterGroups: [{ filters: [flt] }] };
  let rows: GscRow[] = [];
  try { rows = await gscQuery({ ...base, dimensions: ["query"], rowLimit: 25 }); } catch { rows = []; }
  if (!rows.length) return { position: null, impressions: 0, clicks: 0, ctr: null, top_variant: "", top_url: "" };
  let impr = 0, clk = 0, wpos = 0;
  for (const r of rows) { const i = num(r.impressions); impr += i; clk += num(r.clicks); wpos += num(r.position) * i; }
  const best = rows.slice().sort((a, b) => num(b.impressions) - num(a.impressions))[0];
  let topUrl = "";
  try { const pg = await gscQuery({ ...base, dimensions: ["page"], rowLimit: 1 }); topUrl = pg[0]?.keys?.[0] || ""; } catch { /* noop */ }
  return { position: impr ? wpos / impr : null, impressions: impr, clicks: clk, ctr: impr ? clk / impr : null, top_variant: best?.keys?.[0] || "", top_url: topUrl };
}

export type TargetRow = {
  keyword: string; target_url: string | null; intent: string | null; priority: number;
  position: number | null; prev_position: number | null; delta: number | null; status: string;
  impressions: number; clicks: number; ctr: number | null;
  volume: number | null; competitor_position: number | null; top_variant: string; top_url: string;
};
export type MoverRow = { keyword: string; position: number | null; prev_position: number | null; delta: number; impressions: number; clicks: number };
export type MoneyPage = { path: string; sessions: number; conversions: number };
export type SeoReport = {
  window: { from: string; to: string };
  headToHead: { ours: AhrefsMetrics | null; competitor: AhrefsMetrics | null };
  targets: TargetRow[];
  movers: { gaining: MoverRow[]; losing: MoverRow[] };
  moneyPages: MoneyPage[];
  actions: SeoAction[];
  snapshotWeeks: string[];
  sources: { gsc: boolean; ahrefs: boolean; ga: boolean };
};

function statusOf(cur: number | null, prev: number | null, ranking: boolean): string {
  if (!ranking) return "not_ranking";
  if (prev == null || cur == null) return "new";
  const d = prev - cur; // position lower = better; improvement when cur < prev
  if (d >= 1) return "gaining";
  if (d <= -1) return "losing";
  return "holding";
}

// GA4 organic sessions + key events for the money-page paths (best-effort).
async function moneyPageStats(paths: string[], from: string, to: string): Promise<MoneyPage[]> {
  if (!gaConfigured() || !paths.length) return [];
  const organic = { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { matchType: "EXACT", value: "Organic Search" } } };
  try {
    const r = await runReport({
      dateRanges: [{ startDate: from, endDate: to }],
      dimensions: [{ name: "pagePath" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }],
      dimensionFilter: { andGroup: { expressions: [organic, { filter: { fieldName: "pagePath", inListFilter: { values: paths } } }] } },
      limit: 50,
    }) as { rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[] };
    return (r.rows || []).map((row) => ({ path: row.dimensionValues?.[0]?.value || "", sessions: num(row.metricValues?.[0]?.value), conversions: num(row.metricValues?.[1]?.value) }));
  } catch { return []; }
}

export async function buildSeoReport(): Promise<SeoReport> {
  const to = daysAgo(2), from = daysAgo(30);
  const targets = await listTargets();
  const weeks = await snapshotWeeks("target", 12);
  // Prior week = the most recent stored week that ISN'T the current one, for the WoW delta.
  const curWeek = weekStart();
  const prevWeek = weeks.find((w) => w < curWeek) || null;
  const prevSnaps = prevWeek ? await snapshotsForWeek(prevWeek, "target") : [];
  const prevByKw = new Map(prevSnaps.map((s) => [s.keyword.toLowerCase(), s]));
  const prevMoverSnaps = prevWeek ? await snapshotsForWeek(prevWeek, "query") : [];
  const prevMoverByKw = new Map(prevMoverSnaps.map((s) => [s.keyword.toLowerCase(), s]));

  // Ahrefs volume + our/competitor positions (fail-open to empty maps).
  const [ourKw, compKw, ourMetrics, compMetrics] = await Promise.all([
    ahrefsConfigured() ? ahrefsKeywordMap(OUR_DOMAIN) : Promise.resolve(new Map()),
    ahrefsConfigured() ? ahrefsKeywordMap(COMPETITOR) : Promise.resolve(new Map()),
    ahrefsConfigured() ? ahrefsMetrics(OUR_DOMAIN).catch(() => null) : Promise.resolve(null),
    ahrefsConfigured() ? ahrefsMetrics(COMPETITOR).catch(() => null) : Promise.resolve(null),
  ]);

  // Per target term: GSC (real) with Ahrefs position as the fallback when GSC has none.
  const targetRows: TargetRow[] = [];
  for (const t of targets) {
    const kw = t.keyword.toLowerCase();
    let g: TermGsc = { position: null, impressions: 0, clicks: 0, ctr: null, top_variant: "", top_url: "" };
    try { g = await gscTerm(t.keyword, from, to); } catch { /* fail-open */ }
    const ah = ourKw.get(kw);
    const comp = compKw.get(kw);
    const volume = ah?.volume ?? t.volume ?? null;
    const position = g.position != null ? g.position : (ah ? ah.position : null);
    const prev = prevByKw.get(kw)?.position ?? null;
    targetRows.push({
      keyword: t.keyword, target_url: t.target_url, intent: t.intent, priority: t.priority,
      position, prev_position: prev, delta: prev != null && position != null ? +(prev - position).toFixed(1) : null,
      status: statusOf(position, prev, position != null), impressions: g.impressions, clicks: g.clicks, ctr: g.ctr,
      volume, competitor_position: comp ? comp.position : null, top_variant: g.top_variant, top_url: g.top_url,
    });
  }
  targetRows.sort((a, b) => a.priority - b.priority || (b.volume || 0) - (a.volume || 0));

  // Biggest movers across ALL queries (vs the prior weekly snapshot).
  let topQ: GscRow[] = [];
  try { topQ = await gscQuery({ startDate: from, endDate: to, dimensions: ["query"], rowLimit: 300 }); } catch { topQ = []; }
  const movers: MoverRow[] = [];
  for (const r of topQ) {
    const kw = (r.keys?.[0] || "").toLowerCase();
    const prev = prevMoverByKw.get(kw)?.position ?? null;
    if (prev == null) continue;
    const cur = num(r.position);
    const delta = +(prev - cur).toFixed(1);
    if (Math.abs(delta) < 1) continue;
    movers.push({ keyword: r.keys?.[0] || "", position: cur, prev_position: prev, delta, impressions: num(r.impressions), clicks: num(r.clicks) });
  }
  movers.sort((a, b) => b.delta - a.delta);
  const gaining = movers.filter((m) => m.delta > 0).slice(0, 12);
  const losing = movers.filter((m) => m.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 12);

  const paths = [...new Set(targets.map((t) => (t.target_url || "").replace(/^https?:\/\/[^/]+/, "")).filter(Boolean))];
  const moneyPages = await moneyPageStats(paths, from, to);

  return {
    window: { from, to },
    headToHead: { ours: ourMetrics, competitor: compMetrics },
    targets: targetRows,
    movers: { gaining, losing },
    moneyPages,
    actions: await listActions(true),
    snapshotWeeks: weeks,
    sources: { gsc: true, ahrefs: ahrefsConfigured(), ga: gaConfigured() },
  };
}

// Persist THIS week's snapshot (target list + top queries) so future runs have deltas.
export async function snapshotWeek(): Promise<{ week: string; targets: number; queries: number }> {
  const week = weekStart();
  const to = daysAgo(2), from = daysAgo(9); // the trailing 7 complete days
  const targets = await listTargets();
  const ourKw = ahrefsConfigured() ? await ahrefsKeywordMap(OUR_DOMAIN) : new Map();
  const compKw = ahrefsConfigured() ? await ahrefsKeywordMap(COMPETITOR) : new Map();
  const tRows: Omit<Snapshot, "week_start" | "scope">[] = [];
  for (const t of targets) {
    let g: TermGsc = { position: null, impressions: 0, clicks: 0, ctr: null, top_variant: "", top_url: "" };
    try { g = await gscTerm(t.keyword, from, to); } catch { /* noop */ }
    const kw = t.keyword.toLowerCase(); const ah = ourKw.get(kw); const comp = compKw.get(kw);
    tRows.push({ keyword: t.keyword, position: g.position != null ? g.position : (ah ? ah.position : null), impressions: g.impressions, clicks: g.clicks, ctr: g.ctr, volume: ah?.volume ?? t.volume ?? null, ahrefs_position: ah ? ah.position : null, competitor_position: comp ? comp.position : null, top_url: g.top_url });
  }
  const nTargets = await writeSnapshots(week, "target", tRows);

  let topQ: GscRow[] = [];
  try { topQ = await gscQuery({ startDate: from, endDate: to, dimensions: ["query"], rowLimit: 300 }); } catch { topQ = []; }
  const qRows = topQ.map((r) => ({ keyword: r.keys?.[0] || "", position: num(r.position), impressions: num(r.impressions), clicks: num(r.clicks), ctr: num(r.ctr), volume: null, ahrefs_position: null, competitor_position: null, top_url: null }));
  const nQueries = await writeSnapshots(week, "query", qRows);
  return { week, targets: nTargets, queries: nQueries };
}
