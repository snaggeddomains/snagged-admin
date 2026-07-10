// SNAP Names manual list-membership — add a domain we own (found in a registrar
// account by the verification audit) to the list without editing the sheets, or
// remove a prior manual add. Gated by reports.snap_names.write. The report
// (buildSnapNames) merges these in, so an added name shows on the next load.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { addManual, removeManual, type ManualRow } from "@/lib/snap-manual";
import type { SnapSource } from "@/lib/snap-names";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names.write")) {
    return NextResponse.json({ error: "You don't have SNAP Names write access." }, { status: 403 });
  }
  const by = me.email || null;

  let body: { action?: string; domain?: string; source?: SnapSource; owner?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!body.domain) return NextResponse.json({ error: "No domain" }, { status: 400 });

  try {
    if (body.action === "remove") {
      await removeManual(body.domain);
    } else {
      await addManual(body.domain, (body.source || "SNAP") as SnapSource, body.owner ?? null, by);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    const needsMigration = /snap_names_manual|does not exist|schema cache|PGRST205|42P01/i.test(msg);
    return NextResponse.json({ error: needsMigration ? "Run scripts/snap_registrar_inventory.sql (snap_names_manual) on the admin project first." : msg }, { status: 500 });
  }
}

export type { ManualRow };
