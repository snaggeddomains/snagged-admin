// Reports → SNAP Opportunities "worth a look" picks (lazy-loaded by the client so the
// main list renders instantly while the ~10 appraisals run). Same gate as the report.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { buildPicks } from "@/lib/opportunities-picks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.opportunities")) {
    return NextResponse.json({ error: "No access to SNAP Opportunities" }, { status: 403 });
  }
  try {
    const picks = await buildPicks();
    return NextResponse.json({ ok: true, picks });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
