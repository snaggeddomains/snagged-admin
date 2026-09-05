// Bulk RE-MINE of wrong-looking Owner Review cards (broker/none · no seller named) with the
// whole-thread miner, assigning each to Judy. Gated by deals.all/admin. Bounded per call — used by
// the "Re-mine wrong → Judy" button as a test batch; the cron drains the rest unattended.
//   POST { limit?, dry? }
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { remineWrongCards, clearRemineMarkers } from "@/lib/deals/owner-review-mine";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINE_ASSIGNEE = process.env.OWNER_REVIEW_REMINE_ASSIGNEE || "judy@snagged.com";

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { limit?: number; dry?: boolean; mode?: "wrong" | "all"; drain?: boolean; resweep?: boolean };
  const batch = Math.min(Math.max(Number(body.limit) || 40, 1), 60);
  const mode = body.mode === "all" ? "all" : "wrong";
  // resweep (manual button, first batch only): clear remined_at for the target pending set so the sweep
  // reprocesses EVERY card with the current miner — not just the never-mined ones. Done once, before
  // mining, so the drain still terminates (each card is re-stamped as it's mined).
  if (body.resweep && !body.dry) await clearRemineMarkers(mode);
  // Local-mirror reads = zero Gmail, so there's no throttle reason to cap at one small batch. When
  // `drain` is set (the "Re-mine ALL pending" button), loop-drain the WHOLE backlog in one request up
  // to a ~250s time budget (under maxDuration 300); each card is bounded to one re-mine by remined_at,
  // so the loop terminates. A single-batch call (drain:false) stays for the wrong-only test button.
  const drain = body.drain !== false && !body.dry;
  const deadline = Date.now() + 250000;
  try {
    const total = { scanned: 0, updated: 0, found: 0, remaining: 0 } as { scanned: number; updated: number; found: number; remaining: number; note?: string };
    await withGmailFeature("owner-review-remine", async () => {
      do {
        const s = await remineWrongCards({ limit: batch, dry: !!body.dry, assignTo: REMINE_ASSIGNEE, mode });
        total.scanned += s.scanned; total.updated += s.updated; total.found += s.found; total.remaining = s.remaining; total.note = s.note;
        if (!drain || s.note || s.scanned === 0 || s.remaining === 0) break;
      } while (Date.now() < deadline);
    });
    return NextResponse.json({ ok: true, ...total });
  } catch (e) {
    if (isGmailBudgetError(e)) return NextResponse.json({ ok: false, budgetPaused: true, error: GMAIL_BUDGET_MESSAGE }, { status: 429 });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
