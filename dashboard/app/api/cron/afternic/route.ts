// Vercel Cron entry point for the daily afternic SNAP source.
//
// afternic was decoupled from the SNAP Orchestrator: sharing the orchestrator
// runner's 2 cores with the sequential foreground sources slowed it to >3h and
// it was killed by the orchestrator's job timeout. On its OWN runner it's back
// to ~40 min, so it now runs as a standalone workflow dispatched from here.
//
// vercel.json fires this at both 08:00 and 09:00 UTC (EDT/EST); we no-op on the
// hour that isn't 4 AM ET, pinning it to the start of the SLA window year-round
// (same slot as the orchestrator, but on a separate runner — no CPU contention).
//
// Reuses the orchestrator plumbing: CRON_SECRET (auth) + GH_DISPATCH_TOKEN
// (Actions: write). `?force=1` bypasses the hour gate for manual testing.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchWorkflow, isEtHour } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "source-afternic.yml";
// 4 AM ET — the start of the daily SLA window (matches the orchestrator).
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
