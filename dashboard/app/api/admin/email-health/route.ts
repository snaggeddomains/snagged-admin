// Reports → Email Health. Deliverability/health of our sending domains via MXToolbox
// (MX / SPF / DKIM / DMARC / blacklist / DNS). Gated by `reports.email_health`. GET reads the
// cache (fast, no quota); POST {action:'refresh', domain?} re-runs the live checks (spends quota).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { mxtoolboxConfigured, usage } from "@/lib/email-health/mxtoolbox";
import { listReports, refreshHealth, healthDomains, dkimSelectors } from "@/lib/email-health/report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.email_health")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!mxtoolboxConfigured()) return NextResponse.json({ ok: true, configured: false, reports: [], domains: healthDomains() });

  const [reports, u] = await Promise.all([listReports(), usage()]);
  return NextResponse.json({
    ok: true, configured: true, reports,
    domains: healthDomains(), selectors: dkimSelectors(),
    usage: u.ok ? u.data : null,
  });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.email_health")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!mxtoolboxConfigured()) return NextResponse.json({ ok: false, error: "MXTOOLBOX_API_KEY not set" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; domain?: string };
  if (body.action !== "refresh") return NextResponse.json({ error: "action:'refresh' required" }, { status: 400 });
  try {
    const { reports, usage: u } = await refreshHealth(body.domain);
    return NextResponse.json({ ok: true, reports, usage: u });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 502 });
  }
}
