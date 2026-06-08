// Reports → Site Analytics: GET returns one tranche over an ET day range. GA-backed
// tranches (marketplace = /domains/*, blog = /post|/blog SEO content, core = the
// services site) come from the GA4 Data API; the `revenue` tranche comes from the
// Snagged Domain Tracker sheet. Gated by admin.reports.analytics (admins auto-pass).
//
// Read-only: GA4 Data API + Sheets read, both via the Viewer service account.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { analyticsReport, gaConfigured, type Tranche } from "@/lib/ga";
import { revenueReport, revenueConfigured } from "@/lib/revenue";

export const runtime = "nodejs";
export const maxDuration = 60;

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const GA_TRANCHES = new Set<Tranche>(["marketplace", "core", "blog"]);

function etYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.reports.analytics")) {
    return NextResponse.json({ error: "No access to Site Analytics" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const trancheParam = sp.get("tranche") || "core";
  const from = isDate(sp.get("from")) ? (sp.get("from") as string) : etYmd(new Date(Date.now() - 6 * 86400000));
  const to = isDate(sp.get("to")) ? (sp.get("to") as string) : etYmd(new Date());

  // Revenue tranche → the Tracker sheet, not GA.
  if (trancheParam === "revenue") {
    if (!revenueConfigured()) {
      return NextResponse.json({ ok: false, configured: false, error: "Revenue not configured — set GOOGLE_SA_KEY (and share the Tracker sheet with the service account)." }, { status: 200 });
    }
    try {
      const report = await revenueReport(from, to);
      return NextResponse.json({ ok: true, configured: true, tranche: "revenue", from, to, report });
    } catch (e) {
      return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
    }
  }

  if (!gaConfigured()) {
    return NextResponse.json({ ok: false, configured: false, error: "GA not configured — set GA4_PROPERTY_ID and GOOGLE_SA_KEY in this project's env." }, { status: 200 });
  }
  const tranche: Tranche = GA_TRANCHES.has(trancheParam as Tranche) ? (trancheParam as Tranche) : "core";
  try {
    const report = await analyticsReport(tranche, from, to);
    return NextResponse.json({ ok: true, configured: true, tranche, from, to, report });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
