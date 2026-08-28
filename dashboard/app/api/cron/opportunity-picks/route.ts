// "Worth a look" valued picks → Slack (posts split by channel: auctions →
// SLACK_CHANNEL_AUCTIONS, snap → SLACK_CHANNEL_SNAP). Builds the CREAM OF THE CROP among
// new-snap + auctions-expiring-today, valued (appraisal ÷ cost) via the research app, and
// posts the ranked digest. Also warms the research appraisal/TLD cache so the in-app report
// (lazy-loaded picks) is fast for the rest of the day. Auth: CRON_SECRET.
//
// Fired by the SNAP Orchestrator as its final step (right after the full SNAP + auction
// lists are published and state is committed), NOT on a separate fixed-time cron — so the
// picks land soon after the full lists rather than hours later. `?dry=1` builds but doesn't post.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackPost } from "@/lib/orchestrator";
import { buildPicks, bucketSlackPayload } from "@/lib/opportunities-picks";

// Colored left-bar per bucket so the post pops in a busy channel: green for SNAP,
// amber for auctions.
const SNAP_COLOR = "#2eb67d";
const AUCTION_COLOR = "#e8912d";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const picks = await buildPicks();
    // Split by channel: auctions → the auction Slack, snap → the snap Slack. Each posts as a
    // COLORED attachment with a header block so it stands out among the day's other messages.
    const auctionMsg = bucketSlackPayload("🔎 Worth a look — auctions expiring today", picks.auctions, AUCTION_COLOR);
    const snapMsg = bucketSlackPayload("🔎 Worth a look — new SNAP", picks.snap, SNAP_COLOR);
    let auctions: { ok: boolean; error?: string } = { ok: false, error: "empty" };
    let snap: { ok: boolean; error?: string } = { ok: false, error: "empty" };
    if (!dry) {
      if (auctionMsg) auctions = await slackPost(auctionMsg.text, process.env.SLACK_CHANNEL_AUCTIONS, { attachments: auctionMsg.attachments });
      if (snapMsg) snap = await slackPost(snapMsg.text, process.env.SLACK_CHANNEL_SNAP, { attachments: snapMsg.attachments });
    }
    return NextResponse.json({
      ok: true,
      snap: picks.snap.length,
      auctions: picks.auctions.length,
      valued: picks.valued,
      slack: dry ? "skipped (dry)" : { auctions, snap },
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
