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

// Deploy touch 2026-06-08: force a fresh Production build so a rotated CRON_SECRET
// is picked up (a no-diff redeploy is skipped by the Ignored-Build-Step rule).
import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { syncXAdsDaily, xAdsConfigured } from "@/lib/xads";
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
  const daysParam = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysParam) && daysParam > 0 ? Math.min(daysParam, 1500) : 14;
  try {
    const result = await syncXAdsDaily(days);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
