// Internal endpoint: create a SNAP deal from the research app's one-click "Add to SNAP Deals"
// (SNAP Research candidate → Sam's acquisition board). Auth = x-internal-secret ==
// RESEARCH_INTERNAL_SECRET (same pattern as pipedrive-deal / naming-sheet; middleware excludes
// api/internal). Find-or-create by domain so a name is never added twice.

import { NextResponse, type NextRequest } from "next/server";
import { findSnapDealByDomain, createSnapDeal } from "@/lib/snap-deals/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-internal-secret");
  if (!secret || secret !== process.env.RESEARCH_INTERNAL_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { domain?: string; notes?: string; ownerInfo?: string };
  const domain = String(body.domain || "").trim().toLowerCase();
  if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
  const base = process.env.DASHBOARD_BASE || "https://app.snagged.com";
  try {
    let deal = await findSnapDealByDomain(domain);
    let created = false;
    if (!deal) {
      deal = await createSnapDeal({ domain, notes: body.notes, ownerInfo: body.ownerInfo, createdBy: "snap-research", stage: "Qualifying" });
      created = true;
    }
    return NextResponse.json({ ok: true, id: deal.id, url: `${base}/snap-deals/${deal.id}`, created });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
