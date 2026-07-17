// Client Domain Overlap report API. GET → flags + corpus freshness + names-added-per-day
// (accurate, from first_ingested_at) with drill-down, plus a corpus browse mode; POST →
// dismiss/restore a flag by candidate_domain. Gated by reports.client_overlap.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { listFlags, setFlagDismissed } from "@/lib/domain-overlap/store";
import { recentBuildRuns, corpusCount, domainsAddedOn, addedCountsByDay, listCorpus } from "@/lib/domain-corpus/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReports(user, "reports.client_overlap")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const p = req.nextUrl.searchParams;

  // Corpus browse mode: the "view all tracked names" toggle.
  if (p.get("corpus") === "1") {
    const page = Math.max(parseInt(p.get("page") || "0", 10) || 0, 0);
    const limit = 200;
    const { rows, total } = await listCorpus({ q: p.get("q") || "", limit, offset: page * limit });
    return NextResponse.json({ rows, total, page, limit });
  }

  // Drill-down: the actual names first ingested on a given day.
  const addedOn = p.get("addedOn");
  if (addedOn) {
    const domains = await domainsAddedOn(addedOn);
    return NextResponse.json({ addedOn, domains });
  }

  const includeDismissed = p.get("dismissed") === "1";
  const [flags, runs, total, added] = await Promise.all([
    listFlags({ includeDismissed }),
    recentBuildRuns(30),
    corpusCount(),
    addedCountsByDay(21),
  ]);

  const last = runs[0] || null;
  const lastAgeH = last ? (Date.now() - new Date(last.run_at).getTime()) / 3_600_000 : null;
  const health = {
    total,
    lastRunAt: last?.run_at || null,
    lastOk: last?.ok ?? null,
    status: !last ? "yellow" : !last.ok ? "red" : (lastAgeH != null && lastAgeH > 36 ? "yellow" : "green"),
    lastError: last?.error || null,
  };

  return NextResponse.json({ flags, added, health });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReports(user, "reports.client_overlap")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; domain?: string; dismissed?: boolean };
  if (body.action === "dismiss" && body.domain) {
    const ok = await setFlagDismissed(body.domain, body.dismissed !== false);
    return NextResponse.json({ ok });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
