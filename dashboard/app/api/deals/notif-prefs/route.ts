// A user's own deal-notification preferences (which channels they get: in-app / email /
// Slack DM). GET reads them, POST saves. Any signed-in deals user can set their own.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import { getMyPrefs, setMyPrefs } from "@/lib/deals/prefs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canEnterDeals(me)) return NextResponse.json({ error: "No access" }, { status: 403 });
  return NextResponse.json({ ok: true, prefs: await getMyPrefs(me.email) });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canEnterDeals(me)) return NextResponse.json({ error: "No access" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as { in_app?: boolean; email?: boolean; slack?: boolean };
  try {
    const prefs = await setMyPrefs(me.email, { in_app: b.in_app !== false, email: b.email !== false, slack: b.slack !== false });
    return NextResponse.json({ ok: true, prefs });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
