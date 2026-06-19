// Vercel Cron entry point for the NamePros marketplace sweep (3x daily).
//
// Mirrors the Sedo net-new cadence: vercel.json hits this route at every
// candidate UTC hour for the three ET slots (6 AM / 1 PM / 7 PM) and we dispatch
// source-namepros-marketplace.yml only when the real ET hour matches — pinned to
// ET year-round (DST-proof). Reuses the orchestrator plumbing: CRON_SECRET (auth)
// + GH_DISPATCH_TOKEN (Actions: write). `?force=1` bypasses the hour gate.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, dispatchWorkflow, etHourNow } from "@/lib/orchestrator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WORKFLOW = "source-namepros-marketplace.yml";
// 6 AM, 1 PM, 7 PM ET (same slots as the Sedo sweep).
const TARGET_ET_HOURS = [6, 13, 19];

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  const etHour = etHourNow();
  if (!force && !TARGET_ET_HOURS.includes(etHour)) {
    return NextResponse.json({ ok: true, skipped: `not a namepros slot (ET hour ${etHour})` });
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
