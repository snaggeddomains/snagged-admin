// Vercel Cron entry point for the daily afternic SNAP source.
//
// afternic was decoupled from the SNAP Orchestrator: sharing the orchestrator
// runner's 2 cores with the sequential foreground sources slowed it to >3h and
// it was killed by the orchestrator's job timeout. It now runs as a standalone
// workflow dispatched from here.
//
// It is scheduled at 7 AM ET — DELIBERATELY OFFSET from the 4 AM ET orchestrator.
// Even on its own runner, firing at the same tick made afternic and the
// orchestrator's foreground sources write `name_universe` concurrently, and the
// upsert-RPC contention (deadlock/statement-timeout backoffs) dragged afternic to
// >2h so it blew its own timeout ~50% done (2026-06-15). 7 AM ET lands after the
// orchestrator's universe writers finish (~08:45 UTC) and after the 6 AM ET
// sedo-net-new run, giving afternic a clean, contention-free window.
//
// vercel.json fires this at both 11:00 and 12:00 UTC (EDT/EST); we no-op on the
// hour that isn't 7 AM ET, pinning it to 7 AM ET year-round.
//
// Reuses the orchestrator plumbing: CRON_SECRET (auth) + GH_DISPATCH_TOKEN
// (Actions: write). `?force=1` bypasses the hour gate for manual testing.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchWorkflow, isEtHour } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "source-afternic.yml";
// 7 AM ET — offset from the 4 AM ET orchestrator so they don't contend on the
// name_universe upsert (see the header note).
const TARGET_ET_HOUR = 7;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && !isEtHour(TARGET_ET_HOUR)) {
    return NextResponse.json({ ok: true, skipped: "not 7 AM ET" });
  }
  const result = await dispatchWorkflow(WORKFLOW);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, status: result.status },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, dispatched: WORKFLOW });
}
