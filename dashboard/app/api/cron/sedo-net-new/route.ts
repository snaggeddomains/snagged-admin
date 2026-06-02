// Vercel Cron entry point for the Sedo net-new check (3x daily).
//
// Moved off GitHub's `schedule:` trigger, which routinely fired 30-75 min late.
// vercel.json hits this route at every candidate UTC hour for the three ET
// slots (6 AM / 1 PM / 7 PM), and we dispatch source-sedo-net-new.yml only when
// the real ET hour matches — so it's pinned to ET year-round (DST-proof) and
// fires within ~a minute of the slot instead of GitHub's best-effort lag.
//
// Reuses the SNAP orchestrator's plumbing: CRON_SECRET (auth) + GH_DISPATCH_TOKEN
// (Actions: write). `?force=1` bypasses the hour gate for manual testing.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchWorkflow, etHourNow } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "source-sedo-net-new.yml";
// 6 AM, 1 PM, 7 PM ET. vercel.json fires at both the EDT and EST UTC hour for
// each slot; we no-op on the candidate that isn't a real slot right now.
const TARGET_ET_HOURS = [6, 13, 19];

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const etHour = etHourNow();
  if (!force && !TARGET_ET_HOURS.includes(etHour)) {
    return NextResponse.json({ ok: true, skipped: `not a sedo slot (ET hour ${etHour})` });
  }
  const result = await dispatchWorkflow(WORKFLOW);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, status: result.status },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, dispatched: WORKFLOW, etHour });
}
