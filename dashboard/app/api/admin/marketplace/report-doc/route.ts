// Generate the client-facing "Domain Activity Report" Google Doc on demand.
// Assembles the live DealReport + GA + newsletter, renders the branded report,
// and imports it as an editable Doc into the per-domain subfolder (timestamped,
// never overwrites). Gated reports.marketplace. Read-only w.r.t. our data.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { buildDealReport } from "@/lib/marketplace-deals";
import { analyticsReport, gaConfigured, type MarketplaceReport } from "@/lib/ga";
import { getNewsletterFeatures } from "@/lib/newsletter";
import { generateReportDoc, clientReportConfigured } from "@/lib/client-report-doc";
import { gmailConfigured } from "@/lib/gmail";

export const runtime = "nodejs";
export const maxDuration = 300;

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!clientReportConfigured()) return NextResponse.json({ error: "Report generation isn't configured (Google service account / folder)." }, { status: 400 });
  if (!gmailConfigured()) return NextResponse.json({ error: "Gmail isn't configured on this deployment." }, { status: 400 });

  let body: { domain?: string; from?: string; to?: string };
  try { body = await req.json(); } catch { body = {}; }
  const domain = (body.domain || "").toLowerCase().trim().replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return NextResponse.json({ error: "Provide a valid domain" }, { status: 400 });
  const from = isDate(body.from || null) ? body.from! : "2024-01-01";
  const to = isDate(body.to || null) ? body.to! : etYmd(new Date());

  try {
    const [report, ga, nl] = await Promise.all([
      buildDealReport(domain),
      (async () => {
        if (!gaConfigured()) return null;
        try {
          const rep = (await analyticsReport("marketplace", from, to)) as MarketplaceReport;
          return rep.listings.find((l) => l.domain.toLowerCase() === domain) || null;
        } catch { return null; }
      })(),
      getNewsletterFeatures().then((f) => f[domain] || []).catch(() => []),
    ]);

    const host = req.nextUrl.origin;
    const out = await generateReportDoc({ domain, host, from, to, report, ga, newsletter: nl });
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
