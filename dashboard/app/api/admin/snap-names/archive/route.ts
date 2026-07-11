// SNAP Names archive overlay. GET → the list of archived domains; POST
// {domain, archived} → toggle one. Gated by reports.snap_names.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { listArchived, setArchived } from "@/lib/snap-archive";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names")) return NextResponse.json({ error: "No access" }, { status: 403 });
  return NextResponse.json({ ok: true, archived: await listArchived() });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names")) return NextResponse.json({ error: "No access" }, { status: 403 });
  try {
    const body = (await req.json()) as { domain?: string; archived?: boolean; tag?: string | null };
    const domain = String(body.domain || "").trim().toLowerCase();
    if (!domain) return NextResponse.json({ error: "domain required" }, { status: 400 });
    await setArchived(domain, body.archived !== false, me.email || null, body.tag ?? null);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
