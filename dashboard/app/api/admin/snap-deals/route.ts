// SNAP Deals list + create. Gated by the single `snap.deals` module permission (view+edit).
// Shared board — everyone with the permission sees + edits the same deals (no owner scoping).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listSnapDeals, createSnapDeal, boardStats, snapDealsConfigured, type CreateSnapDealInput } from "@/lib/snap-deals/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "snap.deals")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!snapDealsConfigured()) return NextResponse.json({ ok: true, configured: false, deals: [], stats: null });

  const url = new URL(req.url);
  try {
    const deals = await listSnapDeals({ status: url.searchParams.get("status") || undefined, q: url.searchParams.get("q") || undefined });
    return NextResponse.json({ ok: true, configured: true, deals, stats: boardStats(deals), me: me.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "snap.deals")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as CreateSnapDealInput;
  if (!body.domain) return NextResponse.json({ error: "domain is required" }, { status: 400 });
  try {
    const deal = await createSnapDeal({ ...body, createdBy: me.email });
    return NextResponse.json({ ok: true, deal });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
