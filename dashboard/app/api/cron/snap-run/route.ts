// Vercel Cron entry point for the daily SNAP + auction batch.
//
// Scheduled in dashboard/vercel.json to fire at the start of the SLA window
// (~4 AM ET). It dispatches the single "SNAP Orchestrator" GitHub Actions
// workflow, which runs every daily source in order. We do NOT run the pipeline
// here — Vercel functions can't (no Python, no long timeout); GitHub runners do.
//
// Setup: add CRON_SECRET (Vercel sets the Authorization header from it) and
// GH_DISPATCH_TOKEN (fine-grained PAT, Actions: write on snagged-admin).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchOrchestrator, isEtHour } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pinned to exactly 4 AM ET year-round. vercel.json fires this at both 08:00
// and 09:00 UTC (EDT/EST) and we no-op on the hour that isn't 4 AM ET.
const TARGET_ET_HOUR = 4;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // `?force=1` bypasses the ET-hour gate for on-demand testing / manual kicks.
  // Still requires the CRON_SECRET above, so it's not publicly triggerable.
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && !isEtHour(TARGET_ET_HOUR)) {
    return NextResponse.json({ ok: true, skipped: "not 4 AM ET" });
  }
  const result = await dispatchOrchestrator();
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, status: result.status },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, dispatched: "snap-orchestrator.yml" });
}
