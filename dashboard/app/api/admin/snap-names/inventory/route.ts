// SNAP Names registrar-account inventory + reconciliation.
//   GET                         → cached snapshot + hidden set (fast; read perm).
//   POST { action: "rebuild" }  → re-pull every registrar account, persist (write perm).
//   POST { action: "hide"|"unhide", domain } → toggle a domain's audit-hide (write perm).
// The snapshot proves POSSESSION (a name is actually in an account we control), which
// RDAP can't — RDAP only gives the registrar name, not the account.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { readSnapshot, buildAndSaveSnapshot, listHidden, setHidden } from "@/lib/snap-inventory";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names")) return NextResponse.json({ error: "No access to SNAP Names" }, { status: 403 });
  const [snapshot, hidden] = await Promise.all([readSnapshot(), listHidden()]);
  return NextResponse.json({ ok: true, snapshot, hidden });
}

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names.write")) return NextResponse.json({ error: "You don't have SNAP Names write access." }, { status: 403 });
  const by = me.email || null;

  let body: { action?: string; domain?: string; tag?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }

  try {
    if (body.action === "rebuild") {
      const snapshot = await buildAndSaveSnapshot(process.env, by);
      const hidden = await listHidden();
      return NextResponse.json({ ok: true, snapshot, hidden });
    }
    if (body.action === "hide" || body.action === "unhide") {
      if (!body.domain) return NextResponse.json({ error: "No domain" }, { status: 400 });
      await setHidden(body.domain, body.action === "hide", by, body.tag);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const needsMigration = /snap_registrar_inventory|snap_inventory_hidden|does not exist|schema cache|PGRST205|42P01/i.test(msg);
    return NextResponse.json({ error: needsMigration ? "Run scripts/snap_registrar_inventory.sql on the admin project first." : msg }, { status: 500 });
  }
}
