// Owner Review queue API — gated by the `deals` module (same as the Owners directory).
//   GET                        → list cards (+ my pending count + assignable reviewers).
//     ?status=pending|confirmed|rejected|skipped|all  (default pending)
//     ?scope=mine|all           (default mine — only cards assigned to me)
//     ?q=                       filter by domain/candidate
// Per-card actions live in ./[id]/route.ts (confirm/edit/reject/skip/reassign).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { ownerReviewConfigured, listCards, countPending, type OwnerReviewStatus } from "@/lib/deals/owner-review";
import { assignableUsers } from "@/lib/deals/assignees";
import { mirrorStatus } from "@/lib/gmail-mirror";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function gate() {
  const me = await getCurrentUser();
  if (!me) return { me: null, err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return { me: null, err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  return { me, err: null };
}

export async function GET(req: NextRequest) {
  const { me, err } = await gate();
  if (err) return err;
  if (!ownerReviewConfigured()) return NextResponse.json({ ok: true, configured: false, cards: [], myPending: 0, reviewers: [] });
  const url = new URL(req.url);
  try {
    const status = (url.searchParams.get("status") || "pending") as OwnerReviewStatus | "all";
    // scope: "mine" (me + unclaimed, default) · "all" (everyone) · "<email>" (a specific reviewer).
    const scope = url.searchParams.get("scope") || "mine";
    const cards = await listCards({
      status,
      assigned_to: scope === "all" ? undefined : (scope === "mine" ? me!.email : scope),
      include_unassigned: scope === "mine",
      q: url.searchParams.get("q") || undefined,
    });
    const [myPending, reviewers, mirror] = await Promise.all([countPending(me!.email), assignableUsers(), mirrorStatus().catch(() => null)]);
    const canMine = me!.is_admin || userCanAction(me!, "deals.all");   // backfill touches everyone's queue
    return NextResponse.json({ ok: true, configured: true, cards, myPending, reviewers, canMine, me: me!.email, mirror });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
