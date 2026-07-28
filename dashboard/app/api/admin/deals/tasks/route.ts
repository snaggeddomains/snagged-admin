// My Tasks — the signed-in user's Deals to-do list (replies owed, new assignments, due
// boomerangs, deals shared with them). Gated by the `deals` module. Read-only aggregate.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { myTasks } from "@/lib/deals/tasks";
import { assignableUsers } from "@/lib/deals/assignees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(_req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "No access" }, { status: 403 });
  try {
    const [tasks, assignees] = await Promise.all([myTasks(me.email), assignableUsers()]);
    return NextResponse.json({ ok: true, ...tasks, assignees, me: me.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
