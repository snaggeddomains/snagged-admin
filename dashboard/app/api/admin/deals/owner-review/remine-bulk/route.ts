// Bulk RE-MINE of wrong-looking Owner Review cards (broker/none · no seller named) with the
// whole-thread miner, assigning each to Judy. Gated by deals.all/admin. Bounded per call — used by
// the "Re-mine wrong → Judy" button as a test batch; the cron drains the rest unattended.
//   POST { limit?, dry? }
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { remineWrongCards } from "@/lib/deals/owner-review-mine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const REMINE_ASSIGNEE = process.env.OWNER_REVIEW_REMINE_ASSIGNEE || "judy@snagged.com";

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { limit?: number; dry?: boolean };
  const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 40);
  try {
    const summary = await remineWrongCards({ limit, dry: !!body.dry, assignTo: REMINE_ASSIGNEE });
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
