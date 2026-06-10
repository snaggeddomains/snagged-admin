// Reports → Marketplace: per-domain GA4 table for every /marketplace listing.
// Standalone module (own permission reports.marketplace); reuses the GA4
// `marketplace` tranche builder. Read-only (GA4 Data API via the Viewer SA).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { analyticsReport, gaConfigured, type MarketplaceReport } from "@/lib/ga";
import { getNewsletterFeatures, summarizeNewsletter } from "@/lib/newsletter";

export const runtime = "nodejs";
export const maxDuration = 60;

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) {
    return NextResponse.json({ error: "No access to the Marketplace report" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const from = isDate(sp.get("from")) ? (sp.get("from") as string) : etYmd(new Date(Date.now() - 6 * 86400000));
  const to = isDate(sp.get("to")) ? (sp.get("to") as string) : etYmd(new Date());

  if (!gaConfigured()) {
    return NextResponse.json({ ok: true, configured: false, from, to, report: null });
  }
  try {
    const [report, feats] = await Promise.all([
      analyticsReport("marketplace", from, to) as Promise<MarketplaceReport>,
      getNewsletterFeatures().catch(() => ({} as Record<string, never[]>)),
    ]);
    // Newsletter exposure is all-time (cumulative), independent of the GA window.
    const listings = report.listings.map((l) => ({ ...l, newsletter: summarizeNewsletter(feats[l.domain.toLowerCase()]) }));
    return NextResponse.json({ ok: true, configured: true, from, to, report: { ...report, listings } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
