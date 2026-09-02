// Background drain: re-mine the wrong-looking Owner Review cards (broker/none · no seller named)
// with the whole-thread miner and assign each to Judy — so Rob doesn't click "Re-mine" repeatedly.
// ONE batch of `limit` (default 12) per invocation; the vercel.json schedule (every 2 min) sets the
// cadence — a steady 12-per-120s drain, gentle on the shared Gmail quota (no big bursts). Each card
// is re-mined ONCE (remined_at marker), so the drain terminates and later ticks no-op. Auth: CRON_SECRET.
//   ?limit=N per batch (default 12) · ?dry=1 (preview, no writes)
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
  try {
    // ONE batch per invocation — the every-2-min schedule paces the drain (12 per 120s).
    const s = await remineWrongCards({ limit: batch, dry, assignTo: REMINE_ASSIGNEE, requireMarker: !dry });
    if (!dry) await recordHeartbeat("owner-review-remine", { updated: s.updated, found: s.found, remaining: s.remaining }).catch(() => {});
    return NextResponse.json({ ok: true, scanned: s.scanned, updated: s.updated, found: s.found, remaining: s.remaining, note: s.note });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
