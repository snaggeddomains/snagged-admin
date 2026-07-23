// Blog posts from the Webflow CMS — powers Reports → Content. Read-only. Gated by
// `reports.content`. Uses the WEBFLOW_BLOG_POSTS_ID collection; references (author, category)
// are resolved to labels.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { webflowConfigured, loadCollectionResolved } from "@/lib/webflow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.content")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!webflowConfigured()) return NextResponse.json({ ok: true, configured: false, items: [] });

  const collectionId = process.env.WEBFLOW_BLOG_POSTS_ID;
  if (!collectionId) return NextResponse.json({ ok: true, configured: true, resolved: false, items: [], error: "Set WEBFLOW_BLOG_POSTS_ID to the Blog Posts collection id." });

  const res = await loadCollectionResolved(collectionId, { live: true });
  if (!res.ok) return NextResponse.json({ ok: false, configured: true, resolved: true, error: res.error, items: [] }, { status: 502 });
  return NextResponse.json({
    ok: true, configured: true, resolved: true,
    collectionName: res.collection?.displayName || res.collection?.slug || null,
    fields: res.fields, items: res.items, total: res.total,
  });
}
