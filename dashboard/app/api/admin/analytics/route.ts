// Reports → Site Analytics: GET returns the GA4-powered report for one tranche
// (marketplace = /domains/* type-in buyers, core = the services site) over an ET
// day range. Gated by the admin.reports.analytics action (admins/umbrella auto-pass).
//
// Read-only: it only ever calls the GA4 Data API with a Viewer service account.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { analyticsReport, gaConfigured, type Tranche } from "@/lib/ga";

export const runtime = "nodejs";
export const maxDuration = 60;

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Today / N-days-ago as the ET calendar day (matches the property timezone, so
// "today"/"this week" line up with what GA reports).
function etYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.reports.analytics")) {
    return NextResponse.json({ error: "No access to Site Analytics" }, { status: 403 });
  }
  if (!gaConfigured()) {
    return NextResponse.json(
      { ok: false, configured: false, error: "GA not configured — set GA4_PROPERTY_ID and GOOGLE_SA_KEY in this project's env." },
      { status: 200 },
    );
  }

  const sp = req.nextUrl.searchParams;
  const tranche: Tranche = sp.get("tranche") === "core" ? "core" : "marketplace";
  const fromParam = sp.get("from");
  const toParam = sp.get("to");
  const from = isDate(fromParam) ? fromParam : etYmd(new Date(Date.now() - 6 * 86400000));
  const to = isDate(toParam) ? toParam : etYmd(new Date());

  try {
    const report = await analyticsReport(tranche, from, to);
    return NextResponse.json({ ok: true, configured: true, tranche, from, to, report });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
