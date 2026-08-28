// "Worth a look" picks cache. The picks are DAY-scoped (top new-snap + auctions expiring
// TODAY, valued via the research app's appraisal endpoint), and that valuation is the slow,
// system-straining part. Since SNAP Opportunities is now the default SNAP landing, we cache
// the built PicksReport per America/New_York day so a page click serves instantly instead of
// re-valuing the shortlist every time. The daily SNAP-orchestrator cron rebuilds + writes the
// cache (fresh, valued); page loads read it; a manual Refresh (?refresh=1) forces a rebuild.
//
// Storage reuses the existing `cron_heartbeats` table (name→jsonb) so there's NO new
// migration — the cache is disposable (regenerates daily) and tiny (~10 rows of picks).

import { getHeartbeat, recordHeartbeat } from "./cron-heartbeat";
import { buildPicks, type PicksReport } from "./opportunities-picks";
import type { OpportunitiesReport } from "./opportunities";

const CACHE_KEY = "opportunity-picks-cache";

// America/New_York calendar day (YYYY-MM-DD) — the picks are scoped to "expiring TODAY" in
// business tz, so the cache is keyed by the ET day and goes stale at ET midnight.
function etDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// The cached picks for TODAY (ET), or null if there's no cache / it's from a prior day.
export async function getCachedPicks(): Promise<PicksReport | null> {
  const hb = await getHeartbeat(CACHE_KEY);
  const r = hb?.last_result as { day?: string; picks?: PicksReport } | null | undefined;
  if (!r || r.day !== etDay() || !r.picks) return null;
  return r.picks;
}

// Persist a freshly-built PicksReport as today's cache. Best-effort (never throws).
export async function setCachedPicks(picks: PicksReport): Promise<void> {
  try { await recordHeartbeat(CACHE_KEY, { day: etDay(), picks }); } catch { /* best-effort */ }
}

// The read path for the page + route: serve today's cache when present (instant), otherwise
// build once and cache it. `refresh` forces a rebuild (the manual Refresh button / the cron).
export async function getPicksCachedOrBuild(refresh = false, report?: OpportunitiesReport): Promise<{ picks: PicksReport; cached: boolean }> {
  if (!refresh) {
    const cached = await getCachedPicks();
    if (cached) return { picks: cached, cached: true };
  }
  const picks = await buildPicks(report);
  await setCachedPicks(picks);
  return { picks, cached: false };
}
