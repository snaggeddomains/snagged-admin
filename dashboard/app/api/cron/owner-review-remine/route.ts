// Background drain: re-mine the wrong-looking Owner Review cards (broker/none · no seller named)
// with the whole-thread miner and assign each to Judy — so Rob doesn't click "Re-mine" repeatedly.
// Time-boxed loop: processes batches until ~240s elapsed or nothing wrong remains, then no-ops. Each
// card is re-mined ONCE (remined_at marker), so the drain terminates over a few ticks. Auth: CRON_SECRET.
//   ?limit=N per batch (default 12) · ?dry=1 (preview one batch, no writes)
import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { remineWrongCards } from "@/lib/deals/owner-review-mine";
import { recordHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINE_ASSIGNEE = process.env.OWNER_REVIEW_REMINE_ASSIGNEE || "judy@snagged.com";

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const batch = Math.min(Number(url.searchParams.get("limit")) || 12, 40);
  const dry = url.searchParams.get("dry") === "1";
  const deadline = Date.now() + 240000; // stay under maxDuration
  let scanned = 0, updated = 0, found = 0, remaining = 0, note: string | undefined;
  try {
    // One batch in dry mode (preview); otherwise loop until time-boxed or drained.
    do {
      const s = await remineWrongCards({ limit: batch, dry, assignTo: REMINE_ASSIGNEE, requireMarker: !dry });
      scanned += s.scanned; updated += s.updated; found += s.found; remaining = s.remaining; note = s.note;
      if (dry || s.note || s.scanned === 0 || s.remaining === 0) break;
    } while (Date.now() < deadline);
    if (!dry) await recordHeartbeat("owner-review-remine", { updated, found, remaining }).catch(() => {});
    return NextResponse.json({ ok: true, scanned, updated, found, remaining, note });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
