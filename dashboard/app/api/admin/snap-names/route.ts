// SNAP Names report — GET aggregates every purchased / for-sale SNAP domain across
// the two owner spreadsheets into one list. Gated by reports.snap_names (reports
// umbrella / is_admin auto-pass). Read-only (Google Sheets).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { buildSnapNames } from "@/lib/snap-names";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names")) {
    return NextResponse.json({ error: "No access to SNAP Names" }, { status: 403 });
  }
  try {
    const report = await buildSnapNames();
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
