// Vercel Cron entry point for the daily afternic SNAP source.
//
// afternic was decoupled from the SNAP Orchestrator: sharing the orchestrator
// runner's 2 cores with the sequential foreground sources slowed it to >3h and
// it was killed by the orchestrator's job timeout. It now runs as a standalone
// workflow dispatched from here.
//
// It fires FIRST, at 4 AM ET — a 60-minute SOLO head start. afternic is the long
// pole (scans ~27M rows, upserts ~6.2M to name_universe), so it gets a clean,
// contention-free hour to do the bulk of its universe writes. The SNAP
// orchestrator then fires at 5 AM ET (/api/cron/snap-run) and runs the balance of
// the sources alongside afternic's tail. Firing both at the SAME tick made them
// write name_universe concurrently and the upsert-RPC contention
// (deadlock/statement-timeout backoffs) dragged afternic to >2h, blowing its
// timeout ~50% done (2026-06-15) — hence the 1-hour stagger.
//
// vercel.json fires this at both 08:00 and 09:00 UTC (EDT/EST); we no-op on the
// hour that isn't 4 AM ET, pinning it to 4 AM ET year-round.
//
// Reuses the orchestrator plumbing: CRON_SECRET (auth) + GH_DISPATCH_TOKEN
// (Actions: write). `?force=1` bypasses the hour gate for manual testing.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchWorkflow, isEtHour } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "source-afternic.yml";
// 4 AM ET — fires an hour BEFORE the 5 AM ET orchestrator so afternic gets a solo
// head start on the name_universe upsert (see the header note).
const TARGET_ET_HOUR = 4;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && !isEtHour(TARGET_ET_HOUR)) {
    return NextResponse.json({ ok: true, skipped: "not 4 AM ET" });
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
