// Live registrar + nameserver resolution for the SNAP Names report. POST a batch
// of domains → per-domain { registrar, nameservers[], ns_provider }. Gated by
// reports.snap_names. Bounded concurrency, each lookup fail-open. The client sends
// small batches so each request stays well under the timeout and results render
// progressively.

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { resolveMany } from "@/lib/domain-dns";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BATCH = 50;

export async function POST(req: Request) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.snap_names")) {
    return NextResponse.json({ error: "No access to SNAP Names" }, { status: 403 });
  }
  try {
    const body = (await req.json()) as { domains?: unknown };
    const domains = Array.isArray(body.domains)
      ? body.domains.map((d) => String(d || "").trim().toLowerCase()).filter((d) => d.includes("."))
      : [];
    if (!domains.length) return NextResponse.json({ ok: true, results: {} });
    const results = await resolveMany(domains.slice(0, MAX_BATCH), 8);
    return NextResponse.json({ ok: true, results });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
