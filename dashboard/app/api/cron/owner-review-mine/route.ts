// Daily backfill for the Owner Review queue: mine the acquisition thread for Master Txns that
// don't yet have a card (newest first) and create a pending card each. Bounded per run so it
// drains the ~460 backlog over several days AND picks up any NEW Master Txn row as its own card
// once cards exist for the rest. Auth: CRON_SECRET. Best-effort.
//   ?limit=N (default 30) · ?dry=1 (preview, no writes)

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { mineAllTxns } from "@/lib/deals/owner-review-mine";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { withGmailFeature } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 30, 200);
  const dry = url.searchParams.get("dry") === "1";
  try {
    const summary = await withGmailFeature("owner-review-mine", () => mineAllTxns({ limit, dry }));
    if (!dry) await recordHeartbeat("owner-review-mine", { created: summary.created, existing: summary.existing, scanned: summary.scanned }).catch(() => {});
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
