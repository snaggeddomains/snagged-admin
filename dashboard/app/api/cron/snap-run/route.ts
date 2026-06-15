// Vercel Cron entry point for the daily SNAP + auction batch.
//
// Scheduled in dashboard/vercel.json to fire at 5 AM ET (an hour after afternic's
// 4 AM ET solo head start). It dispatches the single "SNAP Orchestrator" GitHub Actions
// workflow, which runs every daily source in order. We do NOT run the pipeline
// here — Vercel functions can't (no Python, no long timeout); GitHub runners do.
//
// Setup: add CRON_SECRET (Vercel sets the Authorization header from it) and
// GH_DISPATCH_TOKEN (fine-grained PAT, Actions: write on snagged-admin).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchOrchestrator, isEtHour } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pinned to exactly 5 AM ET year-round. vercel.json fires this at both 09:00
// and 10:00 UTC (EDT/EST) and we no-op on the hour that isn't 5 AM ET.
// 5 AM (not 4) so afternic — dispatched solo at 4 AM ET by /api/cron/afternic —
// gets a 60-minute contention-free head start on the name_universe upsert before
// the orchestrator's foreground sources start writing it too. Still 2h ahead of
// the 7 AM ET SLA for the ~45-min foreground batch.
const TARGET_ET_HOUR = 5;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const params = new URL(req.url).searchParams;
  // `?ping=1` dispatches the orchestrator in no-op "ping" mode: it proves the
  // full chain (auth -> token -> GitHub dispatch) without running any source.
  // `?force=1` bypasses the ET-hour gate but runs the FULL batch on demand.
  // Both still require the CRON_SECRET above, so neither is publicly triggerable.
  const ping = params.get("ping") === "1";
  const force = ping || params.get("force") === "1";
  if (!force && !isEtHour(TARGET_ET_HOUR)) {
    return NextResponse.json({ ok: true, skipped: "not 5 AM ET" });
  }
  const result = await dispatchOrchestrator(ping ? "ping" : "full");
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, status: result.status },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, dispatched: "snap-orchestrator.yml", mode: ping ? "ping" : "full" });
}
