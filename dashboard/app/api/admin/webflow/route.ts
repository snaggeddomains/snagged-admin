// Webflow CMS admin API — pull + edit the snagged.com Marketplace listings (a Webflow CMS
// collection). Gated by `admin.webflow`. Read/write goes through lib/webflow.ts (Data API v2).
//
//   GET                         → connection status + sites + the resolved site's collections
//                                 (with a best-guess of which one is the Marketplace).
//   GET ?collection=<id>        → that collection's field schema + ALL its items.
//   POST {action:'update', collection, itemId, fieldData, publish?}
//   POST {action:'publish', collection, itemIds}
//   POST {action:'delete', collection, itemId}

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin, type AppUser } from "@/lib/permissions";
import {
  webflowConfigured, webflowCanWrite, defaultSiteId, listSites, listCollections, getCollection,
  listAllItems, updateItem, publishItems, deleteItem, type WfCollection,
} from "@/lib/webflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

function gate(me: AppUser | null): NextResponse | null {
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.webflow")) return NextResponse.json({ error: "No access" }, { status: 403 });
  return null;
}

// Which collection is the Marketplace? An explicit env wins; else guess by name/slug.
function guessMarketplace(collections: WfCollection[]): string | null {
  const env = process.env.WEBFLOW_MARKETPLACE_COLLECTION_ID;
  if (env) return env;
  const re = /market|domain|listing|for.?sale|inventory|name/i;
  const hit = collections.find((c) => re.test(c.displayName || "") || re.test(c.slug || ""));
  return hit?.id || null;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  const err = gate(me); if (err) return err;
  if (!webflowConfigured()) {
    return NextResponse.json({ ok: true, configured: false, sites: [], collections: [] });
  }
  const url = new URL(req.url);
  const collectionId = url.searchParams.get("collection");

  // Detail view: one collection's schema + all its items.
  if (collectionId) {
    const [coll, items] = await Promise.all([getCollection(collectionId), listAllItems(collectionId)]);
    if (!coll.ok) return NextResponse.json({ error: coll.error || "collection load failed" }, { status: 502 });
    return NextResponse.json({
      ok: true, configured: true, canWrite: webflowCanWrite(),
      collection: coll.data,
      fields: coll.data?.fields || [],
      items: items.data?.items || [],
      total: items.data?.total ?? 0,
      itemsError: items.ok ? null : items.error,
    });
  }

  // Overview: sites + the resolved site's collections.
  const sitesR = await listSites();
  if (!sitesR.ok) return NextResponse.json({ ok: false, configured: true, error: sitesR.error, sites: [], collections: [] }, { status: 502 });
  const sites = sitesR.data?.sites || [];
  const siteId = defaultSiteId() || (sites.length === 1 ? sites[0].id : sites[0]?.id) || null;
  let collections: WfCollection[] = [];
  if (siteId) {
    const c = await listCollections(siteId);
    collections = c.data?.collections || [];
  }
  return NextResponse.json({
    ok: true, configured: true, canWrite: webflowCanWrite(), sites, siteId, collections,
    marketplaceCollectionId: guessMarketplace(collections),
  });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  const err = gate(me); if (err) return err;
  if (!webflowConfigured()) return NextResponse.json({ error: "Webflow not configured" }, { status: 503 });
  // A read-only token can pull but never write. Block edits with a clear message.
  if (!webflowCanWrite()) return NextResponse.json({ error: "Read-only token — editing needs a write-scoped WEBFLOW_API_TOKEN." }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string; collection?: string; itemId?: string; itemIds?: string[];
    fieldData?: Record<string, unknown>; publish?: boolean;
  };
  const collection = String(body.collection || "");
  if (!collection) return NextResponse.json({ error: "collection required" }, { status: 400 });

  try {
    switch (body.action) {
      case "update": {
        if (!body.itemId || !body.fieldData) return NextResponse.json({ error: "itemId + fieldData required" }, { status: 400 });
        // Update the staged item; if publish, also push it live (a published item must be
        // re-published to reflect the edit on the live site).
        const r = await updateItem(collection, body.itemId, body.fieldData, { live: !!body.publish });
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
        return NextResponse.json({ ok: true, item: r.data });
      }
      case "publish": {
        const ids = Array.isArray(body.itemIds) ? body.itemIds : (body.itemId ? [body.itemId] : []);
        if (!ids.length) return NextResponse.json({ error: "itemIds required" }, { status: 400 });
        const r = await publishItems(collection, ids);
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
        return NextResponse.json({ ok: true });
      }
      case "unpublish": {
        // Remove the item from the LIVE site (keeps it staged in the CMS) — DELETE …/items/{id}/live.
        if (!body.itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });
        const r = await deleteItem(collection, body.itemId, { live: true });
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
        return NextResponse.json({ ok: true });
      }
      case "delete": {
        // Fully delete the staged item (removes it from the CMS entirely).
        if (!body.itemId) return NextResponse.json({ error: "itemId required" }, { status: 400 });
        const r = await deleteItem(collection, body.itemId, { live: false });
        if (!r.ok) return NextResponse.json({ error: r.error }, { status: 502 });
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
