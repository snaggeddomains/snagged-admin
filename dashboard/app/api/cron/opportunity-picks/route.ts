// Daily "worth a look" valued picks → Slack. Builds the top-5 new-snap + top-5
// auctions-expiring-today, valued (appraisal ÷ cost) via the research app, and posts
// the ranked digest. Also warms the research appraisal/TLD cache so the in-app report
// (lazy-loaded picks) is fast for the rest of the day. Auth: CRON_SECRET.
//   ?dry=1  build but don't post to Slack.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { buildPicks, formatBucketSlack } from "@/lib/opportunities-picks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";
  try {
    const picks = await buildPicks();
    // Split by channel: top-5 auctions → the auction Slack, top-5 snap → the snap Slack.
    const auctionText = formatBucketSlack("🔎 Worth a look — auctions expiring today", picks.auctions);
    const snapText = formatBucketSlack("🔎 Worth a look — new SNAP", picks.snap);
    let auctionsPosted = false;
    let snapPosted = false;
    if (!dry) {
      if (auctionText) auctionsPosted = await slackAlert(auctionText, process.env.SLACK_CHANNEL_AUCTIONS);
      if (snapText) snapPosted = await slackAlert(snapText, process.env.SLACK_CHANNEL_SNAP);
    }
    return NextResponse.json({
      ok: true,
      snap: picks.snap.length,
      auctions: picks.auctions.length,
      valued: picks.valued,
      slack: dry ? "skipped (dry)" : { auctions: auctionsPosted, snap: snapPosted },
    });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
