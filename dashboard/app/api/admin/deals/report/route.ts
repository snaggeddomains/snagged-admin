// Deals Reporting — query + aggregate across ALL deals by any permutation (status, owner,
// stage, source, priority, budget band, value range, date, search). Gated by deals.reports.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { reportDeals, reportAggregates, type ReportFilters } from "@/lib/deals/store";
import { assignableUsers } from "@/lib/deals/assignees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin && !userCanAction(me, "deals.reports")) return NextResponse.json({ error: "No access to Deals reporting" }, { status: 403 });

  const s = new URL(req.url).searchParams;
  const numOr = (v: string | null) => { if (!v) return undefined; const n = Number(v.replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : undefined; };
  const f: ReportFilters = {
    status: s.get("status") || undefined,
    owner: s.get("owner") || undefined,
    stage: s.get("stage") || undefined,
    source: s.get("source") || undefined,
    priority: s.get("priority") || undefined,
    budgetBand: s.get("budgetBand") || undefined,
    minAsking: numOr(s.get("minAsking")),
    maxAsking: numOr(s.get("maxAsking")),
    q: s.get("q") || undefined,
    from: s.get("from") || undefined,
    to: s.get("to") || undefined,
  };
  try {
    const deals = await reportDeals(f);
    const aggregates = reportAggregates(deals);
    const assignees = await assignableUsers();
    return NextResponse.json({ ok: true, deals, aggregates, assignees });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
