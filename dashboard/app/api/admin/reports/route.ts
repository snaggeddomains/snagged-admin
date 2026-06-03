// Reports → Cost: GET returns the raw usage buckets + editable rates (the client
// computes $ live so rate edits reflect instantly); POST upserts one rate.
// Gated by the admin.reports.cost action (admins/umbrella auto-pass via canAdmin).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { listRates, upsertRate, costTotals, costSeries, type Period } from "@/lib/cost-report";

export const runtime = "nodejs";
export const maxDuration = 60;

function periodOf(v: string | null): Period {
  return v === "week" || v === "month" ? v : "day";
}

// Convert a wall-clock time on a given calendar day in a timezone to the matching
// UTC instant. The offset between the same naive instant read as `tz` vs `UTC`
// IS the zone offset for that day (so EDT/EST is handled automatically), and the
// server's own timezone cancels out — correct on Vercel (UTC) or anywhere.
const ET = "America/New_York";
function zonedToUtcISO(dateStr: string, timeStr: string, tz: string): string {
  const naive = new Date(`${dateStr}T${timeStr}Z`);
  const asTz = new Date(naive.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(naive.getTime() + (asUtc.getTime() - asTz.getTime())).toISOString();
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.reports.cost")) {
    return NextResponse.json({ error: "No access to the cost report" }, { status: 403 });
  }
  const period = periodOf(req.nextUrl.searchParams.get("period"));
  const category = req.nextUrl.searchParams.get("category") || null;
  // Custom range (YYYY-MM-DD, treated as UTC days) takes precedence over the
  // rolling "last N days" preset. `to` is inclusive → upper bound is end-of-day.
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let since: string;
  let until: string | null;
  if (isDate(from)) {
    // from/to are ET calendar days (inclusive) → ET midnight..end-of-day in UTC.
    since = zonedToUtcISO(from, "00:00:00.000", ET);
    until = isDate(to) ? zonedToUtcISO(to, "23:59:59.999", ET) : new Date().toISOString();
  } else {
    const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") || "30", 10) || 30, 1), 730);
    since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    until = null;
  }
  try {
    const [totals, series, rates] = await Promise.all([
      costTotals(since, until),
      costSeries(period, since, category, until),
      listRates(),
    ]);
    return NextResponse.json({ ok: true, period, category, since, until, totals, series, rates });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.reports.cost")) {
    return NextResponse.json({ error: "No access to edit rates" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    meter?: string;
    usd_per_unit?: number | string;
    unit_label?: string | null;
  };
  const meter = String(body.meter || "").trim();
  if (!meter) return NextResponse.json({ error: "Missing meter" }, { status: 400 });
  const rate = Number(body.usd_per_unit);
  if (!Number.isFinite(rate) || rate < 0) {
    return NextResponse.json({ error: "usd_per_unit must be a non-negative number" }, { status: 400 });
  }
  try {
    await upsertRate(meter, rate, body.unit_label ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
