// Live Marketplace listings from Webflow CMS — powers the "Live listings" section on
// Reports → Marketplace. Read-only (works with a read-only Webflow token). Gated by
// `reports.marketplace`. Returns the PUBLISHED (live) items of the marketplace collection.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { webflowConfigured, resolveMarketplaceCollectionId, getCollection, listAllItems } from "@/lib/webflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!webflowConfigured()) return NextResponse.json({ ok: true, configured: false, items: [] });

  const collectionId = await resolveMarketplaceCollectionId();
  if (!collectionId) return NextResponse.json({ ok: true, configured: true, resolved: false, items: [], error: "Couldn't find the Marketplace collection — set WEBFLOW_MARKETPLACE_COLLECTION_ID." });

  const [coll, items] = await Promise.all([getCollection(collectionId), listAllItems(collectionId, { live: true })]);
  if (!items.ok) return NextResponse.json({ ok: false, configured: true, resolved: true, error: items.error, items: [] }, { status: 502 });
  return NextResponse.json({
    ok: true, configured: true, resolved: true,
    collectionId,
    collectionName: coll.data?.displayName || coll.data?.slug || null,
    fields: coll.data?.fields || [],
    items: items.data?.items || [],
    total: items.data?.total ?? (items.data?.items || []).length,
  });
}
