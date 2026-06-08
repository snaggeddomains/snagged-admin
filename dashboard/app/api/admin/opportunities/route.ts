// Reports → New Opportunities: GET aggregates snap new-today + live auctions across
// all sources. Gated by the reports.opportunities action (reports umbrella / is_admin
// auto-pass). Read-only (GitHub state files + naming enrichment lookups).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { newOpportunities } from "@/lib/opportunities";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.opportunities")) {
    return NextResponse.json({ error: "No access to SNAP Opportunities" }, { status: 403 });
  }
  try {
    const report = await newOpportunities();
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
