// Reads the API-usage log + admin-editable rates from the MAIN research DB
// (domain_research_api_usage / domain_research_cost_rates — written by the
// research app's lib/db/usage.js) and aggregates them for the Reports → Cost
// tab. getDb() points at that project (same one the bell + imports log use).

import { getDb, isDbConfigured } from "./supabase";

const RATES = "domain_research_cost_rates";

export type Rate = { meter: string; usd_per_unit: number; unit_label: string | null };
export type Total = { category: string; meter: string; units: number };
export type SeriesPoint = { bucket: string; cost: number };
export type Period = "day" | "week" | "month";

export async function listRates(): Promise<Rate[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb()
    .from(RATES)
    .select("meter,usd_per_unit,unit_label")
    .order("meter");
  if (error) return [];
  return (data ?? []).map((r) => ({
    meter: r.meter as string,
    usd_per_unit: Number(r.usd_per_unit) || 0,
    unit_label: (r.unit_label as string | null) ?? null,
  }));
}

export async function upsertRate(meter: string, usdPerUnit: number, unitLabel: string | null): Promise<void> {
  if (!isDbConfigured() || !meter) return;
  const { error } = await getDb()
    .from(RATES)
    .upsert(
      { meter, usd_per_unit: usdPerUnit, unit_label: unitLabel, updated_at: new Date().toISOString() },
      { onConflict: "meter" },
    );
  if (error) throw new Error(`upsertRate: ${error.message}`);
}

// Every meter that has EVER been logged (all-time), so the rate card can price
// meters even when they're absent from the current window.
export async function listAllMeters(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  const since = new Date("2000-01-01T00:00:00.000Z").toISOString();
  const { data, error } = await getDb().rpc("cost_totals", { p_since: since, p_until: null });
  if (error) return [];
  const set = new Set<string>();
  for (const r of (data ?? []) as { meter: string }[]) set.add(String(r.meter));
  return Array.from(set);
}

// Totals per (category, meter) within [since, until) — the client pivots into
// by-system / by-category / the per-meter rate editor and applies (live) rates.
export async function costTotals(sinceISO: string, untilISO: string | null = null): Promise<Total[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().rpc("cost_totals", { p_since: sinceISO, p_until: untilISO });
  if (error) return [];
  return (data ?? []).map((r: { category: string; meter: string; units: number | string }) => ({
    category: String(r.category || "uncategorized"),
    meter: String(r.meter),
    units: Number(r.units) || 0,
  }));
}

// $ per day/week/month bucket using SAVED rates (optionally one category, within
// [since, until)).
export async function costSeries(period: Period, sinceISO: string, category: string | null, untilISO: string | null = null): Promise<SeriesPoint[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().rpc("cost_series", {
    p_period: period,
    p_since: sinceISO,
    p_category: category || null,
    p_until: untilISO,
  });
  if (error) return [];
  return (data ?? []).map((r: { bucket: string; cost: number | string }) => ({
    bucket: String(r.bucket),
    cost: Number(r.cost) || 0,
  }));
}
