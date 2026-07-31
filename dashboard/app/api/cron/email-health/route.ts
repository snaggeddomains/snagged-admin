// Daily email-health sweep — re-run the MXToolbox checks for our sending domains, cache them,
// and ALERT (bell + email + Slack) when a NEW failure appears (a domain gets blacklisted, SPF/
// DKIM/DMARC breaks, MX goes bad). Auth: CRON_SECRET. Best-effort throughout.
//   ?dry=1  run + report without alerting.

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron, slackAlert } from "@/lib/orchestrator";
import { canReports } from "@/lib/permissions";
import { listUsers } from "@/lib/users";
import { createNotification } from "@/lib/notifications";
import { sendEmail, emailConfigured } from "@/lib/email";
import { recordHeartbeat } from "@/lib/cron-heartbeat";
import { mxtoolboxConfigured } from "@/lib/email-health/mxtoolbox";
import { refreshHealth, getStoredFailing } from "@/lib/email-health/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const APP_BASE = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/+$/, "");
const CHECK_LABEL: Record<string, string> = { mx: "MX", spf: "SPF", dkim: "DKIM", dmarc: "DMARC", blacklist: "Blacklist", dns: "DNS" };

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!mxtoolboxConfigured()) return NextResponse.json({ ok: true, skipped: "MXTOOLBOX_API_KEY not set" });
  const dry = new URL(req.url).searchParams.get("dry") === "1";

  // Capture the prior failing set BEFORE the refresh so we only alert on NEWLY-failing checks.
  const before = await getStoredFailing().catch(() => ({} as Record<string, string[]>));
  const { reports } = await refreshHealth();

  const newlyFailing: { domain: string; checks: string[] }[] = [];
  for (const rep of reports) {
    const prev = new Set(before[rep.domain] || []);
    const fresh = rep.failing.filter((k) => !prev.has(k));
    if (fresh.length) newlyFailing.push({ domain: rep.domain, checks: fresh });
  }

  let notified = false;
  if (newlyFailing.length && !dry) {
    const lines = newlyFailing.map((n) => `• *${n.domain}* — ${n.checks.map((c) => CHECK_LABEL[c] || c).join(", ")} failing`);
    const title = `⚠️ Email health: ${newlyFailing.length} domain${newlyFailing.length === 1 ? "" : "s"} newly failing`;
    const link = `${APP_BASE}/reports/email-health`;
    try {
      const users = (await listUsers()).filter((u) => canReports(u, "reports.email_health"));
      const ids = users.map((u) => u.id).filter(Boolean);
      if (ids.length) await createNotification(ids, { kind: "email_health", title, body: lines.join("\n"), link });
      if (emailConfigured()) {
        const to = [...new Set(users.map((u) => String(u.email || "").trim().toLowerCase()).filter(Boolean))];
        if (to.length) await sendEmail({ to, subject: title, html: `<p>${lines.join("<br>")}</p><p><a href="${link}">Open Email Health →</a></p>` });
      }
      await slackAlert(`${title}\n${lines.join("\n")}\n<${link}|Open Email Health →>`, process.env.SLACK_CHANNEL_EMAIL_HEALTH);
      notified = true;
    } catch { /* best-effort */ }
  }

  await recordHeartbeat("email-health", { domains: reports.length, newlyFailing: newlyFailing.length, notified }).catch(() => {});
  return NextResponse.json({ ok: true, domains: reports.map((r) => ({ domain: r.domain, grade: r.grade, failing: r.failing })), newlyFailing, notified, dry });
}
