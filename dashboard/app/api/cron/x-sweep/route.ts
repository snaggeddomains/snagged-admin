// X (Twitter) domain-opportunity sweep cron. Runs the recent-search queries, scores
// each tweet, persists high-signal/maybe (deduped), delivers the NET-NEW to
// reports.social_sweep users (Slack + email + bell). Shares the store/digest with Reddit.
//
// Auth: CRON_SECRET (Vercel bearer).  ?dry=1 → run + persist but don't send the digest.
//
// NB: needs X_BEARER_TOKEN, or X_API_KEY + X_API_SECRET (bearer minted at runtime), in
// this Vercel project, AND the X project on the Basic tier or higher (recent search is
// not on the Free tier → 403).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { runXSweep } from "@/lib/reddit-sweep/x-run";
import { buildSweepDigest } from "@/lib/reddit-sweep/digest";
import { sendEmail, emailConfigured } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { listUsers } from "@/lib/users";
import { canReports } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const dry = req.nextUrl.searchParams.get("dry") === "1";

  const summary = await runXSweep();
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
    // Post to the dedicated content-sweep channel when configured (else falls back to SNAP).
    const slackOk = await slackAlert(digest.slack, process.env.SLACK_CHANNEL_CONTENT_SWEEP);
    let emailed = 0;
    if (emailConfigured() && recipients.length) {
      const ok = await sendEmail({ to: recipients.map((r) => r.email), subject: digest.subject, html: digest.html });
      if (ok) emailed = recipients.length;
    }
    await createNotification(recipients.map((r) => r.id).filter(Boolean), {
      kind: "social_sweep",
      title: `${summary.high} new high-signal domain lead${summary.high === 1 ? "" : "s"} on X`,
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
