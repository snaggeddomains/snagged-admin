// Vercel Cron entry point for the X (Twitter) Ads daily-metrics cache.
//
// Unlike snap-run (which dispatches a GitHub workflow because the pipeline needs
// Python), this sync is pure fetch + Supabase upsert, so it runs inline here. It
// pulls the trailing few days of per-campaign daily stats from the Ads API and
// upserts them into x_ads_daily — finalized days stay put, recent days get
// corrected as X revises them. The Ads report then reads from the table (fast,
// consistent, no per-pageview API load / 429s).
//
// Scheduled in dashboard/vercel.json. Setup: CRON_SECRET (Vercel sends it as the
// Authorization bearer) + the X_ADS_* and SUPABASE_* env vars. Run the one-time
// table SQL (scripts/x_ads_cache.sql) first.
//
//   ?days=N   sync the trailing N days (default 14). Pass a large N ONCE — with the
//             secret — to backfill history, e.g. ?days=1200.

// Deploy touch 2026-06-08 (2): force a fresh Production build so the re-set
// CRON_SECRET is picked up (a no-diff redeploy is skipped by the Ignored-Build-Step rule).
import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { syncXAdsDaily, syncXAdsAdsDaily, xAdsConfigured } from "@/lib/xads";
import { xAdsStoreConfigured } from "@/lib/xads-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // backfills fan out a lot of throttled API calls

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!xAdsConfigured()) {
    return NextResponse.json({ ok: false, error: "X Ads not configured (X_ADS_* env vars missing)." }, { status: 200 });
  }
  if (!xAdsStoreConfigured()) {
    return NextResponse.json({ ok: false, error: "Cache DB not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)." }, { status: 200 });
  }
  // ?days=N → trailing N days (default 14). ?from=YYYY-MM-DD&to=YYYY-MM-DD → an
  // explicit window, for backfilling history in segments (a single multi-year pull
  // can exceed the 300s function limit; segment it and each one upserts on its own).
  const sp = new URL(req.url).searchParams;
  const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const daysParam = Number(sp.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 1500) : 14;
  const from = isDate(sp.get("from")) ? (sp.get("from") as string) : undefined;
  const to = isDate(sp.get("to")) ? (sp.get("to") as string) : undefined;
  // ?level=campaign | ad | both (default both) — backfills can be run per-level to
  // stay under the 300s limit.
  const level = sp.get("level") || "both";
  const opts = from ? { from, to } : { days };
  try {
    const result: Record<string, unknown> = { ok: true, level };
    if (level !== "ad") {
      const c = await syncXAdsDaily(opts);
      result.campaignRows = c.rows; result.from = c.from; result.to = c.to;
    }
    if (level !== "campaign") {
      const a = await syncXAdsAdsDaily(opts);
      result.adRows = a.rows; result.from = a.from; result.to = a.to;
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
