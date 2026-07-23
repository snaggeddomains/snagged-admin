// Live Marketplace listings from Webflow CMS — powers the "Live listings" section on
// Reports → Marketplace. Read-only (works with a read-only Webflow token). Gated by
// `reports.marketplace`. Returns the PUBLISHED (live) items of the marketplace collection.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { webflowConfigured, defaultSiteId, listSites, listCollections, getCollection, listAllItems, type WfCollection } from "@/lib/webflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

const MARKET_RE = /market|domain|listing|for.?sale|inventory|name/i;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!webflowConfigured()) return NextResponse.json({ ok: true, configured: false, items: [] });

  const url = new URL(req.url);
  // ?all=1 → the FULL collection (published + staged/draft), for the Marketplace Master view;
  // default → only the published (live) listings, for the Reports → Marketplace section.
  const all = url.searchParams.get("all") === "1";
  const chosen = url.searchParams.get("collection"); // explicit pick from the UI

  // Gather the site's collections (best-effort) so the UI can offer a picker if we can't
  // auto-identify the Marketplace one. Surface the underlying error (e.g. a token missing
  // the Sites-read scope) so it's diagnosable.
  let collections: WfCollection[] = [];
  let discoverError: string | null = null;
  const sites = await listSites();
  if (!sites.ok) discoverError = sites.error;
  const siteId = defaultSiteId() || sites.data?.sites?.[0]?.id;
  if (siteId) {
    const c = await listCollections(siteId);
    if (c.ok) collections = c.data?.collections || []; else discoverError = discoverError || c.error;
  }
  const collectionsLite = collections.map((c) => ({ id: c.id, name: c.displayName || c.slug || c.id, slug: c.slug || null }));

  const collectionId = chosen
    || process.env.WEBFLOW_MARKETPLACE_COLLECTION_ID
    || collections.find((c) => MARKET_RE.test(c.displayName || "") || MARKET_RE.test(c.slug || ""))?.id
    || null;

  if (!collectionId) {
    return NextResponse.json({
      ok: true, configured: true, resolved: false, collections: collectionsLite, discoverError, items: [],
      error: collectionsLite.length ? "Pick the Marketplace collection." : "Couldn't list collections — the token may lack Sites-read, or set WEBFLOW_MARKETPLACE_COLLECTION_ID.",
    });
  }

  const [coll, items] = await Promise.all([getCollection(collectionId), listAllItems(collectionId, { live: !all })]);
  if (!items.ok) return NextResponse.json({ ok: false, configured: true, resolved: true, collections: collectionsLite, collectionId, error: items.error, items: [] }, { status: 502 });

  const fields = coll.data?.fields || [];
  const rows = items.data?.items || [];
  // Reference / Multi-reference fields (e.g. Extension, Categories) come back as item IDs, not
  // labels. Resolve them: fetch each referenced collection once, map id→name, then swap the ids
  // in each row for a readable "com" / "Tech, Finance". Best-effort — a failed lookup leaves ids.
  const refFields = fields.filter((f) => /reference/i.test(f.type) && f.validations?.collectionId);
  const targetIds = [...new Set(refFields.map((f) => f.validations!.collectionId!))];
  const nameMaps: Record<string, Record<string, string>> = {};
  await Promise.all(targetIds.map(async (tid) => {
    const r = await listAllItems(tid);
    const m: Record<string, string> = {};
    for (const it of r.data?.items || []) m[it.id] = String((it.fieldData?.name ?? it.fieldData?.slug ?? it.id) as string);
    nameMaps[tid] = m;
  }));
  if (refFields.length) {
    for (const it of rows) {
      for (const f of refFields) {
        const m = nameMaps[f.validations!.collectionId!]; if (!m) continue;
        const v = it.fieldData[f.slug];
        if (Array.isArray(v)) it.fieldData[f.slug] = v.map((id) => m[String(id)] || String(id)).join(", ");
        else if (typeof v === "string" && v) it.fieldData[f.slug] = m[v] || v;
      }
    }
  }

  return NextResponse.json({
    ok: true, configured: true, resolved: true,
    collectionId, collections: collectionsLite,
    collectionName: coll.data?.displayName || coll.data?.slug || null,
    fields, items: rows,
    total: items.data?.total ?? rows.length,
  });
}
