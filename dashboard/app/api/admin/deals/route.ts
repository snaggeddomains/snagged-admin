// Deals list + create. Gated by the `deals` module (deals.all sees everyone's; otherwise
// a user sees their own deals + the unassigned Inbox). Create is the manual path (a deal
// added straight on the board); the triage/research convert also lands here via createDeal.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { listDeals, createDeal, boardStats, searchBuyers, dealsConfigured, type CreateDealInput } from "@/lib/deals/store";
import { notifyAssignment } from "@/lib/deals/notify";
import { kickResearchRun } from "@/lib/deals/research-link";
import { assignableUsers } from "@/lib/deals/assignees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!dealsConfigured()) return NextResponse.json({ ok: true, configured: false, deals: [], assignees: [], stats: null });

  const url = new URL(req.url);
  // Buyer typeahead (returning clients) — ?buyers=<query> → known buyers from prior deals.
  const buyersQ = url.searchParams.get("buyers");
  if (buyersQ != null) {
    try { return NextResponse.json({ ok: true, buyers: await searchBuyers(buyersQ) }); }
    catch (e) { return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 }); }
  }
  const all = me.is_admin || userCanAction(me, "deals.all");
  const inbox = all || userCanAction(me, "deals.inbox");
  try {
    const deals = await listDeals({ all, inbox, me: me.email, status: url.searchParams.get("status") || undefined, q: url.searchParams.get("q") || undefined });
    const stats = await boardStats(deals);
    const assignees = await assignableUsers(); // {email,name} — only "can receive deals" users
    return NextResponse.json({ ok: true, configured: true, deals, stats, assignees, canSeeAll: all, me: me.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as CreateDealInput;
  if (!body.domain) return NextResponse.json({ error: "domain is required" }, { status: 400 });
  try {
    const { deal, created } = await createDeal({ ...body, createdBy: me.email });
    if (created && deal.owner_email) await notifyAssignment(deal);
    // A manually-added deal usually has no research report — kick a FREE pre-flight so it
    // auto-links (same rule as a report that already exists). Best-effort, non-blocking.
    if (created && !deal.report_link) { try { await kickResearchRun(deal.domain); } catch { /* non-fatal */ } }
    return NextResponse.json({ ok: true, deal, created });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
