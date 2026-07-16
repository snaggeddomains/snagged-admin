// Daily overlap match: reads the (freshly rebuilt) client corpus, matches today's new
// marketplace/pipeline names against it, writes flags, and delivers the digest to
// reports.client_overlap users (Slack + email + bell). Runs AFTER /api/cron/client-corpus.
//
// Auth: CRON_SECRET (Vercel bearer).
//   ?since=YYYY-MM-DD   candidate lookback (default today).
//   ?dry=1              run + persist flags but don't send the digest.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { runOverlap } from "@/lib/domain-overlap/run";
import { buildDigest } from "@/lib/domain-overlap/digest";
import { sendEmail, emailConfigured } from "@/lib/email";
import { createNotification } from "@/lib/notifications";
import { listUsers } from "@/lib/users";
import { canReports } from "@/lib/permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const since = p.get("since") || undefined;
  const dry = p.get("dry") === "1";

  const summary = await runOverlap({ since });
  const digest = buildDigest(summary.newFlags, summary.runDate);

  let delivered: { slack: boolean; email: number } = { slack: false, email: 0 };
  if (digest && !dry) {
    // Recipients = users who can see the report.
    let recipients: { id: string; email: string }[] = [];
    try {
      const users = await listUsers();
      recipients = users
        .filter((u) => canReports(u, "reports.client_overlap"))
        .map((u) => ({ id: String((u as { id?: unknown }).id || ""), email: String((u as { email?: unknown }).email || "") }))
        .filter((u) => u.email);
    } catch {
      /* fall back to no email recipients */
    }
    const slackOk = await slackAlert(digest.slack);
    let emailed = 0;
    if (emailConfigured() && recipients.length) {
      const ok = await sendEmail({ to: recipients.map((r) => r.email), subject: digest.subject, html: digest.html });
      if (ok) emailed = recipients.length;
    }
    await createNotification(recipients.map((r) => r.id).filter(Boolean), {
      kind: "client_overlap",
      title: `${digest.count} new client-domain match${digest.count === 1 ? "" : "es"}`,
      body: summary.exactTld ? `${summary.exactTld} same-word new-TLD hits` : null,
      link: "/reports/client-overlap",
    });
    delivered = { slack: slackOk, email: emailed };
  }

  const { newFlags, ...rest } = summary;
  return NextResponse.json({ ...rest, matched: newFlags.length, delivered: dry ? "skipped (dry)" : delivered }, { status: summary.ok ? 200 : 500 });
}
