// Bulk backfill for the Owner Review queue — mine the acquisition thread for every Master Txn
// that doesn't yet have a card, determine the SELLER (direction-aware, full name + contact +
// channel + confidence) via an LLM, and upsert a pending card. Heavy (Gmail + one LLM call per
// domain) → gated to deals.all / admin, bounded by `limit`, and it's the same engine the cron uses.
//   POST { limit?: number, dry?: boolean }   (dry = preview, no writes)

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { mineAllTxns } from "@/lib/deals/owner-review-mine";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  // Backfill touches everyone's queue → require the broad grant (or admin).
  if (!me.is_admin && !userCanAction(me, "deals.all") && !userCan(me, "deals")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { limit?: number; dry?: boolean };
  try {
    // New cards are assigned to whoever clicked Mine, so they land in that person's "Assigned to me".
    // Governed background read — halts at the Gmail safety line to protect the shared quota.
    const summary = await withGmailFeature("owner-review-mine", () => mineAllTxns({ limit: Math.min(Number(body.limit) || 12, 60), dry: !!body.dry, assignTo: me.email }));
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    if (isGmailBudgetError(e)) return NextResponse.json({ ok: false, budgetPaused: true, error: GMAIL_BUDGET_MESSAGE }, { status: 429 });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
