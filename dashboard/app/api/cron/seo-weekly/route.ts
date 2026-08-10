// Weekly SEO snapshot + digest. Persists this week's per-keyword GSC/Ahrefs snapshot
// (so week-over-week position deltas accrue), then sends the digest: in-app bell +
// email (reports.seo users + always rob@) + Slack. Auth: CRON_SECRET.
//   ?dry=1  build + snapshot without sending.  ?nosnap=1  skip the snapshot write.
import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { canReports } from "@/lib/permissions";
import { listUsers } from "@/lib/users";
import { createNotification } from "@/lib/notifications";
import { sendEmail, emailConfigured } from "@/lib/email";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { gscConfigured } from "@/lib/gsc";
import { snapshotWeek } from "@/lib/seo/report";
import { buildSeoDigest } from "@/lib/seo/digest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const APP_BASE = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/+$/, "");
const ALWAYS = (process.env.SEO_DIGEST_EXTRA_EMAILS || "rob@snagged.com").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!gscConfigured()) return NextResponse.json({ ok: true, skipped: "GSC not configured" });
  const url = new URL(req.url);
  const dry = url.searchParams.get("dry") === "1";
  const nosnap = url.searchParams.get("nosnap") === "1";

  let snap = { week: "", targets: 0, queries: 0 };
  if (!nosnap) { try { snap = await snapshotWeek(); } catch { /* keep going — digest still builds off the live pull */ } }

  const digest = await buildSeoDigest();
  const link = `${APP_BASE}/reports/seo`;
  let notified = false;

  if (!dry) {
    try {
      const users = await listUsers();
      const permd = users.filter((u) => canReports(u, "reports.seo"));
      const ids = permd.map((u) => u.id).filter(Boolean);
      if (ids.length) await createNotification(ids, { kind: "seo", title: digest.subject, body: null, link });
      if (emailConfigured()) {
        const to = [...new Set([...permd.map((u) => String(u.email || "").trim().toLowerCase()), ...ALWAYS].filter(Boolean))];
        if (to.length) await sendEmail({ to, subject: digest.subject, html: digest.html });
      }
      await slackAlert(digest.slack, process.env.SLACK_CHANNEL_SEO);
      notified = true;
    } catch { /* best-effort */ }
  }

  await recordHeartbeat("seo-weekly", { week: snap.week, targets: snap.targets, notified }).catch(() => {});
  return NextResponse.json({ ok: true, snapshot: snap, notified, dry });
}
