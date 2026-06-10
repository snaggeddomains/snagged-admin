// Vercel Cron entry point for the newsletter-feature cache. Pure fetch +
// Supabase upsert (like x-ads-sync), so it runs inline. Scans each sent MailChimp
// campaign's HTML body, keeps only current /marketplace listings, and upserts into
// newsletter_features. Incremental (skips already-scanned campaigns); the
// Marketplace report reads the cache.
//
// Auth: CRON_SECRET (Vercel sends it as the Authorization bearer). Setup: run
// scripts/newsletter_cache.sql once, then hit this once to backfill.
//   ?rescan=1   re-scan every campaign (e.g. after the listing set changed).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { syncNewsletterFeatures, newsletterConfigured } from "@/lib/newsletter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // a full backfill fetches ~130 campaign bodies

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!newsletterConfigured()) {
    return NextResponse.json({ ok: false, error: "Not configured (MAILCHIMP_API_KEY + SUPABASE_URL/SERVICE_ROLE_KEY)." }, { status: 200 });
  }
  const rescan = req.nextUrl.searchParams.get("rescan") === "1";
  try {
    const res = await syncNewsletterFeatures({ rescan });
    return NextResponse.json({ ok: true, ...res });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
