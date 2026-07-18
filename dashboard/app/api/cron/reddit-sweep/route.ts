// Reddit domain-opportunity sweep cron. Fetches every subreddit's /new feed, scores
// each post, persists high-signal/maybe (deduped), and delivers a digest of the
// NET-NEW posts to reports.social_sweep users (Slack + email + bell).
//
// Auth: CRON_SECRET (Vercel bearer).
//   ?dry=1   run + persist but don't send the digest (use once to seed the baseline).
//
// NB: Reddit IP-blocks cloud egress → set SCRAPE_DO_API_KEY (or SCRAPE_DO_TOKEN) in
// this (snagged-admin) Vercel project, or every fetch 403s and the run reports
// feed-errors for all subs.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { runRedditSweep } from "@/lib/reddit-sweep/run";
import { buildSweepDigest } from "@/lib/reddit-sweep/digest";
import { sendEmail, emailConfigured } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { listUsers } from "@/lib/users";
import { canReports } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const summary = await runRedditSweep();
  const digest = buildSweepDigest(summary.newPosts);

  let delivered: { slack: boolean; email: number } | string = { slack: false, email: 0 };
  if (digest && !dry) {
    let recipients: { id: string; email: string }[] = [];
    try {
      const users = await listUsers();
      recipients = users
        .filter((u) => canReports(u, "reports.social_sweep"))
        .map((u) => ({ id: String((u as { id?: unknown }).id || ""), email: String((u as { email?: unknown }).email || "") }))
        .filter((u) => u.email);
    } catch { /* no email recipients */ }
    const slackOk = await slackAlert(digest.slack);
    let emailed = 0;
    if (emailConfigured() && recipients.length) {
      const ok = await sendEmail({ to: recipients.map((r) => r.email), subject: digest.subject, html: digest.html });
      if (ok) emailed = recipients.length;
    }
    await createNotification(recipients.map((r) => r.id).filter(Boolean), {
      kind: "social_sweep",
      title: `${summary.high} new high-signal domain lead${summary.high === 1 ? "" : "s"} on Reddit`,
      body: null,
      link: "/reports/social-sweep",
    });
    delivered = { slack: slackOk, email: emailed };
  } else if (dry) {
    delivered = "skipped (dry)";
  }

  const { newPosts, ...rest } = summary;
  return NextResponse.json({ ...rest, matched: newPosts.length, delivered }, { status: summary.ok ? 200 : 500 });
}
