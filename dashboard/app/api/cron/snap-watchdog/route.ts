// Vercel Cron watchdog for the SNAP batch.
//
// Scheduled near the SLA deadline (~7 AM ET). It confirms the orchestrator
// actually ran today and self-heals the one failure mode the autofix workflow
// can't see: the orchestrator never started (dispatch dropped / not triggered).
//
//   - run today succeeded / still running  -> OK, nothing to do.
//   - run today FAILED                      -> the autofix workflow already saw
//                                              it; we just Slack a heads-up.
//   - NO run today                          -> re-dispatch once + Slack-alert.
//
// Re-dispatch can't loop: this cron fires once per day, and after a dispatch
// there is a run "today", so the next day's check starts clean.

import { NextResponse, type NextRequest } from "next/server";
import {
  authorizedCron,
  dispatchOrchestrator,
  isEtHour,
  latestRunToday,
  recentOrchestratorRuns,
  slackAlert,
} from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Pinned to exactly 7 AM ET year-round (the SLA deadline). vercel.json fires
// this at both 11:00 and 12:00 UTC (EDT/EST); we no-op off the 7 AM ET hour.
const TARGET_ET_HOUR = 7;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // `?force=1` bypasses the ET-hour gate for on-demand testing. The watchdog
  // is read-only when a run already exists today (it only dispatches if NONE
  // ran), so this is a safe, non-destructive way to verify auth + token + the
  // GitHub Actions read path without triggering the orchestrator.
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && !isEtHour(TARGET_ET_HOUR)) {
    return NextResponse.json({ ok: true, skipped: "not 7 AM ET" });
  }

  const runs = await recentOrchestratorRuns(15);
  const today = latestRunToday(runs);

  if (!today) {
    const redispatched = await dispatchOrchestrator();
    await slackAlert(
      `:rotating_light: SNAP watchdog: the orchestrator did *not* run today. ` +
        (redispatched.ok
          ? "Re-dispatched it now."
          : `Re-dispatch FAILED (${redispatched.error}). Run "SNAP Orchestrator" manually.`),
    );
    return NextResponse.json(
      { ok: false, reason: "no_run_today", redispatched: redispatched.ok },
      { status: 200 },
    );
  }

  if (today.status === "completed" && today.conclusion !== "success") {
    await slackAlert(
      `:warning: SNAP watchdog: today's orchestrator run concluded "${today.conclusion}". ` +
        `Auto-fix should be on it. ${today.html_url}`,
    );
    return NextResponse.json(
      { ok: false, reason: "run_failed", conclusion: today.conclusion, url: today.html_url },
      { status: 200 },
    );
  }

  // success, or still queued/in_progress (started fine — that's what we check).
  return NextResponse.json({
    ok: true,
    status: today.status,
    conclusion: today.conclusion,
    url: today.html_url,
  });
}
