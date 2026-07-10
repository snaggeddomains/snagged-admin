// Which registrar providers are "wired" right now (API keys present in this env).
// Returns booleans only — never the keys. Lets the Updates bar show a live
// "wired / not-wired" readout so you can confirm env vars took effect. Gated by
// reports.snap_names.write.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { PROVIDERS } from "@/lib/registrar/registry";

export const runtime = "nodejs";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names.write")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const env = process.env;
  const providers = Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    wired: p.hasKeys(env),
    canNS: p.canNS,
    canDNS: p.canDNS,
  }));
  return NextResponse.json({ ok: true, providers });
}
