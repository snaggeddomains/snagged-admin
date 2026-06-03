// Reads the API-usage log + admin-editable rates from the MAIN research DB
// (domain_research_api_usage / domain_research_cost_rates — written by the
// research app's lib/db/usage.js) and aggregates them for the Reports → Cost
// tab. getDb() points at that project (same one the bell + imports log use).

import { getDb, isDbConfigured } from "./supabase";

const RATES = "domain_research_cost_rates";

export type Rate = { meter: string; usd_per_unit: number; unit_label: string | null };
export type Bucket = { bucket: string; meter: string; units: number };
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

// Day/week/month buckets per meter via the server-side RPC (small result set).
export async function usageBuckets(period: Period, sinceISO: string): Promise<Bucket[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().rpc("cost_usage_buckets", {
    p_period: period,
    p_since: sinceISO,
  });
  if (error) return [];
  return (data ?? []).map((r: { bucket: string; meter: string; units: number | string }) => ({
    bucket: String(r.bucket),
    meter: String(r.meter),
    units: Number(r.units) || 0,
  }));
}
