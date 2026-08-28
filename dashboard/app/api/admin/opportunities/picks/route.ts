// Reports → SNAP Opportunities "worth a look" picks (lazy-loaded by the client so the
// main list renders instantly while the ~10 appraisals run). Same gate as the report.
//
// CACHE-FIRST: the picks are day-scoped + the valuation is the slow part, and this report is
// now the default SNAP landing — so a page click serves the day's CACHED picks instantly
// (populated by the daily SNAP-orchestrator cron). `?refresh=1` forces a rebuild (the manual
// Refresh button).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { getPicksCachedOrBuild } from "@/lib/picks-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.opportunities")) {
    return NextResponse.json({ error: "No access to SNAP Opportunities" }, { status: 403 });
  }
  try {
    const refresh = req.nextUrl.searchParams.get("refresh") === "1";
    const { picks, cached } = await getPicksCachedOrBuild(refresh);
    return NextResponse.json({ ok: true, picks, cached });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
