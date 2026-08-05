// Deals list + create. Gated by the `deals` module (deals.all sees everyone's; otherwise
// a user sees their own deals + the unassigned Inbox). Create is the manual path (a deal
// added straight on the board); the triage/research convert also lands here via createDeal.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { listDeals, getDealsByIds, createDeal, addActivity, boardStats, searchBuyers, dealsConfigured, type CreateDealInput } from "@/lib/deals/store";
import { sharedDealIdsFor } from "@/lib/deals/sharing";
import { pendingReminders } from "@/lib/deals/reminders";
import { notifyAssignment } from "@/lib/deals/notify";
import { kickResearchRun } from "@/lib/deals/research-link";
import { assignableUsers } from "@/lib/deals/assignees";
import { getHeartbeat } from "@/lib/cron-heartbeat";
import { countBuyInquiries } from "@/lib/inquiries";

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
  // "Shared with me" scope — deals other people looped this user into (view + comment).
  if (url.searchParams.get("scope") === "shared") {
    try {
      const deals = await getDealsByIds(await sharedDealIdsFor(me.email));
      const [stats, assignees] = await Promise.all([boardStats(deals), assignableUsers()]);
      return NextResponse.json({ ok: true, configured: true, deals, stats, assignees, scope: "shared", canSeeAll: all, me: me.email });
    } catch (e) { return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 }); }
  }
  try {
    const deals = await listDeals({ all, inbox, me: me.email, status: url.searchParams.get("status") || undefined, q: url.searchParams.get("q") || undefined });
    const stats = await boardStats(deals);
    const assignees = await assignableUsers(); // {email,name} — only "can receive deals" users
    const emailSync = await getHeartbeat("deal-emails"); // proof the hourly email cron fired
    // The Inbox column points to the buy-side opportunity queue — surface the pending count so the
    // (usually empty) Unassigned/Inbox column links to where new opportunities actually land. Only
    // for users who can open that tab (research.pipedrive).
    const inquiryCount = userCan(me, "research.pipedrive") ? await countBuyInquiries() : null;
    // Deals this user has snoozed to a FUTURE date — the board's "Hide snoozed" toggle drops
    // these until their revisit date arrives (then they resurface on their My Tasks as boomerangs).
    const now = Date.now();
    const snoozedIds = [...new Set((await pendingReminders(me.email).catch(() => []))
      .filter((r) => Date.parse(r.remind_at) > now).map((r) => r.deal_id))];
    return NextResponse.json({ ok: true, configured: true, deals, stats, assignees, emailSync, inquiryCount, snoozedIds, canSeeAll: all, me: me.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as CreateDealInput & { comment?: string };
  if (!body.domain) return NextResponse.json({ error: "domain is required" }, { status: 400 });
  const comment = body.comment ? String(body.comment).trim() : "";
  try {
    const { deal, created } = await createDeal({ ...body, createdBy: me.email });
    // Optional free-text pretext → posted as the deal's first comment (timeline), attributed to
    // the creator. Separate from Notes; best-effort so it never blocks deal creation.
    if (comment) { try { await addActivity(deal.id, { user_email: me.email, kind: "comment", body: comment, meta: null }); } catch { /* non-fatal */ } }
    if (created && deal.owner_email) await notifyAssignment(deal);
    // A manually-added deal usually has no research report — kick a FREE pre-flight so it
    // auto-links (same rule as a report that already exists). Best-effort, non-blocking.
    if (created && !deal.report_link) { try { await kickResearchRun(deal.domain); } catch { /* non-fatal */ } }
    return NextResponse.json({ ok: true, deal, created });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
