// Notifications bell endpoint for the admin chrome. GET returns the current
// user's recent notifications + unread count; POST { ids? } marks read (all when
// ids omitted). Backed by the main research DB, shared with the research module.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listNotifications, countUnread, markRead } from "@/lib/notifications";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const [items, unread] = await Promise.all([listNotifications(me.id, 20), countUnread(me.id)]);
  return NextResponse.json({ ok: true, items, unread });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { ids?: string[] };
  await markRead(me.id, Array.isArray(body.ids) ? body.ids : undefined);
  const unread = await countUnread(me.id);
  return NextResponse.json({ ok: true, unread });
}
