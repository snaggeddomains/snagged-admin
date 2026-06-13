// Reports → Site Analytics: GET returns one tranche over an ET day range. GA-backed
// tranches (marketplace = /domains/*, blog = /post|/blog SEO content, core = the
// services site) come from the GA4 Data API; the `revenue` tranche comes from the
// Snagged Domain Tracker sheet. Gated by admin.reports.analytics (admins auto-pass).
//
// Read-only: GA4 Data API + Sheets read, both via the Viewer service account.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { analyticsReport, gaConfigured, type Tranche } from "@/lib/ga";
import { revenueReport, revenueConfigured } from "@/lib/revenue";
import { seoReport, gscConfigured, type SeoBucket } from "@/lib/gsc";
import { xAdsReport, xAdsLift, xAdsEffectiveness, xAdsConfigured } from "@/lib/xads";
import { leadsReport, leadsConfigured } from "@/lib/leads";
import { newsletterReport, mailchimpConfigured, recentMemberCounts } from "@/lib/mailchimp";
import { histSignups, histUnsubs, mergeDaily, emailDataThrough } from "@/lib/historical-email";

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
  if (!canReports(me, "reports.analytics")) {
    return NextResponse.json({ error: "No access to Site Analytics" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const trancheParam = sp.get("tranche") || "core";
  const from = isDate(sp.get("from")) ? (sp.get("from") as string) : etYmd(new Date(Date.now() - 6 * 86400000));
  const to = isDate(sp.get("to")) ? (sp.get("to") as string) : etYmd(new Date());

  // Email tranche → signup/unsub history (bundled export, always available) plus the
  // live Mailchimp audience/campaign report when the key is configured.
  if (trancheParam === "email") {
    let live = { signups: {} as Record<string, number>, unsubs: {} as Record<string, number> };
    let newsletter = null;
    if (mailchimpConfigured()) {
      try { live = await recentMemberCounts(emailDataThrough); } catch { /* historical-only */ }
      try { newsletter = await newsletterReport(from, to); } catch { /* historical-only */ }
    }
    const signups = mergeDaily(histSignups, live.signups, from, to);
    const unsubs = mergeDaily(histUnsubs, live.unsubs, from, to);
    const through = mailchimpConfigured() ? etYmd(new Date()) : emailDataThrough;
    return NextResponse.json({ ok: true, configured: true, tranche: "email", from, to, report: { newsletter, signups, unsubs, through, live: mailchimpConfigured() } });
  }

  // SEO tranche → Google Search Console, not GA.
  if (trancheParam === "seo") {
    if (!gscConfigured()) {
      return NextResponse.json({ ok: false, configured: false, error: "Search Console not configured — set GOOGLE_SA_KEY and add the SA to the GSC property." }, { status: 200 });
    }
    try {
      const bp = sp.get("bucket");
      const bucket: SeoBucket = bp === "core" || bp === "marketplace" || bp === "blog" ? bp : "all";
      const report = await seoReport(from, to, bucket);
      return NextResponse.json({ ok: true, configured: true, tranche: "seo", from, to, report });
    } catch (e) {
      return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
    }
  }

  // Ads tranche → the X (Twitter) Ads API, with the ROI headline pulling the
  // X-attributed lead count from core GA inside xAdsReport.
  if (trancheParam === "ads") {
    if (!xAdsConfigured()) {
      return NextResponse.json({ ok: false, configured: false, error: "X Ads not configured — set X_ADS_CONSUMER_KEY / X_ADS_CONSUMER_SECRET / X_ADS_ACCESS_TOKEN / X_ADS_ACCESS_TOKEN_SECRET / X_ADS_ACCOUNT_ID in this project's env." }, { status: 200 });
    }
    // The lift model recomputes a trailing 90-day window (~40 throttled X API
    // calls) — too heavy to ride on the main spend load (it was timing out), so
    // the client fetches it as a separate `part=lift` request, lazily.
    if (sp.get("part") === "lift") {
      if (!gaConfigured()) return NextResponse.json({ ok: true, configured: true, tranche: "ads", part: "lift", lift: null });
      try {
        const lift = await xAdsLift(to);
        return NextResponse.json({ ok: true, configured: true, tranche: "ads", part: "lift", lift });
      } catch (e) {
        return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
      }
    }
    // Per-campaign + per-ad effectiveness (engagement efficiency, runtime, weekly
    // trend) — its own lazy `part=effectiveness` request like lift.
    if (sp.get("part") === "effectiveness") {
      try {
        const effectiveness = await xAdsEffectiveness(from, to);
        return NextResponse.json({ ok: true, configured: true, tranche: "ads", part: "effectiveness", effectiveness });
      } catch (e) {
        return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
      }
    }
    // Actual lead identities (name/email/domains/source) parsed from the inquiry@
    // submission emails + a best-effort revenue tie-back to the Deals tab. Its own
    // lazy `part=leads` request (Gmail + Sheets reads — heavier than the spend view).
    if (sp.get("part") === "leads") {
      if (!leadsConfigured()) return NextResponse.json({ ok: true, configured: true, tranche: "ads", part: "leads", leads: null });
      try {
        const leads = await leadsReport(from, to);
        return NextResponse.json({ ok: true, configured: true, tranche: "ads", part: "leads", leads });
      } catch (e) {
        return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
      }
    }
    try {
      const report = await xAdsReport(from, to); // spend view honors [from, to]; lift loaded separately
      return NextResponse.json({ ok: true, configured: true, tranche: "ads", from, to, report });
    } catch (e) {
      return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
    }
  }

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
