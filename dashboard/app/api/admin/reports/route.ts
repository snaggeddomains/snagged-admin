// Reports → Cost: GET returns the raw usage buckets + editable rates (the client
// computes $ live so rate edits reflect instantly); POST upserts one rate.
// Gated by the admin.reports.cost action (admins/umbrella auto-pass via canAdmin).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { listRates, upsertRate, usageBuckets, type Period } from "@/lib/cost-report";

export const runtime = "nodejs";
export const maxDuration = 60;

function periodOf(v: string | null): Period {
  return v === "week" || v === "month" ? v : "day";
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.reports.cost")) {
    return NextResponse.json({ error: "No access to the cost report" }, { status: 403 });
  }
  const period = periodOf(req.nextUrl.searchParams.get("period"));
  const days = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("days") || "30", 10) || 30, 1), 730);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  try {
    const [buckets, rates] = await Promise.all([usageBuckets(period, since), listRates()]);
    return NextResponse.json({ ok: true, period, days, buckets, rates });
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
