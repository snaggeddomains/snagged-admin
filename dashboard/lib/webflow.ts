// Webflow Data API v2 client — https://developers.webflow.com/data/reference
// snagged.com is a Webflow CMS site (the marketplace listings are a CMS collection). This
// is the typed, dependency-free client for reading + managing collections and items, mirroring
// the shape of lib/hubspot.ts / lib/pipedrive.ts: every call returns {ok,data,error} so nothing
// throws, and it's fail-open when unconfigured (no token → ok:false, callers degrade).
//
// Auth: a Webflow **Site API token** (Site settings → Apps & integrations → API access →
// Generate API token). Scoped to one site. Separate write/read env vars, so a READ-ONLY token can
// be wired for pulling data without granting write access:
//   WEBFLOW_API_KEY / WEBFLOW_API_TOKEN / WEBFLOW_SITE_TOKEN  — a WRITE-scoped token (CMS read+write) — enables editing
//   WEBFLOW_API_TOKEN_CMS_READ_ONLY                           — a READ-only token — pulls work, edits blocked
//   WEBFLOW_SITE_ID                                           — default site id (optional; discoverable via listSites)
// A write token (if set) is preferred for everything; otherwise the read-only token serves reads.

const BASE = "https://api.webflow.com/v2";

function writeToken(): string | undefined {
  return process.env.WEBFLOW_API_KEY || process.env.WEBFLOW_API_TOKEN || process.env.WEBFLOW_SITE_TOKEN;
}
function token(): string | undefined {
  return writeToken() || process.env.WEBFLOW_API_TOKEN_CMS_READ_ONLY;
}
export function webflowConfigured(): boolean {
  return Boolean(token());
}
// True only when a write-scoped token is present — the UI hides editing otherwise.
export function webflowCanWrite(): boolean {
  return Boolean(writeToken());
}
export function defaultSiteId(): string | undefined {
  return process.env.WEBFLOW_SITE_ID || undefined;
}

export type WfResult<T = unknown> = { ok: boolean; status: number; data: T | null; error: string | null };

// Low-level request. Retries once on a 429 (Webflow's default limit is 60 req/min) honoring
// Retry-After. Never throws — returns {ok,data,error}.
export async function wf<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<WfResult<T>> {
  const t = token();
  if (!t) return { ok: false, status: 0, data: null, error: "WEBFLOW_API_TOKEN not set" };
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${t}`,
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(25000),
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("retry-after")) || 2, 10) * 1000 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      return wf<T>(method, path, body, attempt + 1);
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = (json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : null) || text || `HTTP ${res.status}`;
      return { ok: false, status: res.status, data: json as T, error: msg };
    }
    return { ok: true, status: res.status, data: json as T, error: null };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: String((e as Error)?.message || e) };
  }
}

// ---- Sites ----
export type WfSite = { id: string; displayName?: string; shortName?: string; previewUrl?: string; lastPublished?: string; customDomains?: { url: string }[] };
export async function listSites(): Promise<WfResult<{ sites: WfSite[] }>> {
  return wf<{ sites: WfSite[] }>("GET", "/sites");
}
export async function getSite(siteId: string): Promise<WfResult<WfSite>> {
  return wf<WfSite>("GET", `/sites/${siteId}`);
}
// Publish a site (to the webflow.io subdomain and/or its custom domains).
export async function publishSite(siteId: string, opts?: { toSubdomain?: boolean; customDomainIds?: string[] }): Promise<WfResult> {
  return wf("POST", `/sites/${siteId}/publish`, {
    publishToWebflowSubdomain: opts?.toSubdomain ?? true,
    ...(opts?.customDomainIds ? { customDomains: opts.customDomainIds } : {}),
  });
}

// ---- Collections ----
export type WfField = { id: string; slug: string; displayName?: string; type: string; isRequired?: boolean; isEditable?: boolean; validations?: { collectionId?: string; options?: { id: string; name: string }[] } | null };
export type WfCollection = { id: string; displayName?: string; slug?: string; singularName?: string; fields?: WfField[] };
export async function listCollections(siteId: string): Promise<WfResult<{ collections: WfCollection[] }>> {
  return wf<{ collections: WfCollection[] }>("GET", `/sites/${siteId}/collections`);
}
// Full collection incl. its field schema (slugs + types) — needed before writing items.
export async function getCollection(collectionId: string): Promise<WfResult<WfCollection>> {
  return wf<WfCollection>("GET", `/collections/${collectionId}`);
}

// Resolve the Marketplace listings collection id: an explicit env pin wins, else the resolved
// site's collection whose name/slug reads like a marketplace/domains list. null if not found.
export async function resolveMarketplaceCollectionId(): Promise<string | null> {
  if (process.env.WEBFLOW_MARKETPLACE_COLLECTION_ID) return process.env.WEBFLOW_MARKETPLACE_COLLECTION_ID;
  const sites = await listSites();
  const siteId = defaultSiteId() || sites.data?.sites?.[0]?.id;
  if (!siteId) return null;
  const c = await listCollections(siteId);
  const re = /market|domain|listing|for.?sale|inventory|name/i;
  const hit = (c.data?.collections || []).find((x) => re.test(x.displayName || "") || re.test(x.slug || ""));
  return hit?.id || null;
}

// ---- Items ----
export type WfItem = { id: string; isArchived?: boolean; isDraft?: boolean; lastPublished?: string | null; lastUpdated?: string; createdOn?: string; fieldData: Record<string, unknown> };
export type WfItemsPage = { items: WfItem[]; pagination?: { limit: number; offset: number; total: number } };

// One page of items. limit ≤ 100 (Webflow cap). Pass `live: true` to read the PUBLISHED set.
export async function listItems(collectionId: string, opts: { limit?: number; offset?: number; live?: boolean } = {}): Promise<WfResult<WfItemsPage>> {
  const p = new URLSearchParams();
  p.set("limit", String(Math.min(opts.limit ?? 100, 100)));
  if (opts.offset) p.set("offset", String(opts.offset));
  const suffix = opts.live ? "/items/live" : "/items";
  return wf<WfItemsPage>("GET", `/collections/${collectionId}${suffix}?${p.toString()}`);
}

// EVERY item across all pages (paginates until exhausted). Bounded by maxPages for safety.
export async function listAllItems(collectionId: string, opts: { live?: boolean; maxPages?: number } = {}): Promise<WfResult<{ items: WfItem[]; total: number }>> {
  const items: WfItem[] = [];
  let offset = 0, total = 0;
  const maxPages = opts.maxPages ?? 50;
  for (let page = 0; page < maxPages; page++) {
    const r = await listItems(collectionId, { limit: 100, offset, live: opts.live });
    if (!r.ok || !r.data) return { ok: false, status: r.status, data: null, error: r.error };
    items.push(...(r.data.items || []));
    total = r.data.pagination?.total ?? items.length;
    offset += r.data.items?.length || 0;
    if (!r.data.items?.length || items.length >= total) break;
  }
  return { ok: true, status: 200, data: { items, total }, error: null };
}

export async function getItem(collectionId: string, itemId: string): Promise<WfResult<WfItem>> {
  return wf<WfItem>("GET", `/collections/${collectionId}/items/${itemId}`);
}

// Create an item. `live: true` creates it already published (else it's staged as a draft in the
// CMS until the site/collection is published). fieldData keys are the field SLUGS from getCollection.
export async function createItem(
  collectionId: string,
  fieldData: Record<string, unknown>,
  opts: { live?: boolean; isDraft?: boolean; isArchived?: boolean } = {},
): Promise<WfResult<WfItem>> {
  const suffix = opts.live ? "/items/live" : "/items";
  return wf<WfItem>("POST", `/collections/${collectionId}${suffix}`, {
    isArchived: opts.isArchived ?? false,
    isDraft: opts.isDraft ?? false,
    fieldData,
  });
}

export async function updateItem(
  collectionId: string,
  itemId: string,
  fieldData: Record<string, unknown>,
  opts: { live?: boolean } = {},
): Promise<WfResult<WfItem>> {
  // For a SINGLE item, `/live` goes AFTER the item id (…/items/{id}/live), unlike the
  // collection-level list/create where it's …/items/live.
  const live = opts.live ? "/live" : "";
  return wf<WfItem>("PATCH", `/collections/${collectionId}/items/${itemId}${live}`, { fieldData });
}

export async function deleteItem(collectionId: string, itemId: string, opts: { live?: boolean } = {}): Promise<WfResult> {
  const live = opts.live ? "/live" : "";
  return wf("DELETE", `/collections/${collectionId}/items/${itemId}${live}`);
}

// Publish specific staged items (make draft/updated items live without a full site publish).
export async function publishItems(collectionId: string, itemIds: string[]): Promise<WfResult> {
  if (!itemIds.length) return { ok: true, status: 200, data: null, error: null };
  return wf("POST", `/collections/${collectionId}/items/publish`, { itemIds });
}

// Fetch a collection's field schema + all its items, with Reference / Multi-reference fields
// resolved from item ids to their human labels (e.g. Author → "Rob Schutz", Category → "SEO").
// Read-only helper shared by the marketplace + content report surfaces.
export async function loadCollectionResolved(
  collectionId: string,
  opts: { live?: boolean } = {},
): Promise<{ ok: boolean; error: string | null; collection: WfCollection | null; fields: WfField[]; items: WfItem[]; total: number }> {
  const [coll, items] = await Promise.all([getCollection(collectionId), listAllItems(collectionId, { live: opts.live })]);
  const fields = coll.data?.fields || [];
  const rows = items.data?.items || [];
  const refFields = fields.filter((f) => /reference/i.test(f.type) && f.validations?.collectionId);
  const targetIds = [...new Set(refFields.map((f) => f.validations!.collectionId!))];
  const nameMaps: Record<string, Record<string, string>> = {};
  await Promise.all(targetIds.map(async (tid) => {
    const r = await listAllItems(tid);
    const m: Record<string, string> = {};
    for (const it of r.data?.items || []) m[it.id] = String((it.fieldData?.name ?? it.fieldData?.slug ?? it.id) as string);
    nameMaps[tid] = m;
  }));
  for (const it of rows) {
    for (const f of refFields) {
      const m = nameMaps[f.validations!.collectionId!]; if (!m) continue;
      const v = it.fieldData[f.slug];
      if (Array.isArray(v)) it.fieldData[f.slug] = v.map((id) => m[String(id)] || String(id)).join(", ");
      else if (typeof v === "string" && v) it.fieldData[f.slug] = m[v] || v;
    }
  }
  return { ok: items.ok, error: items.error, collection: coll.data, fields, items: rows, total: items.data?.total ?? rows.length };
}
