// Auto email ingestion — pulls the relevant Gmail threads onto each OPEN deal so the
// deal module + each deal stay current without anyone clicking "Pull emails". Hourly.
// Auth: CRON_SECRET. Bounded (a cap + one deal at a time) to stay within Gmail quota.
//   ?limit=N  cap deals processed this run (default 120).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { gmailConfigured } from "@/lib/gmail";
import { listDeals, dealsConfigured } from "@/lib/deals/store";
import { ingestDealEmails } from "@/lib/deals/emails";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!dealsConfigured() || !gmailConfigured()) return NextResponse.json({ ok: true, skipped: "deals or gmail not configured" });

  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit")) || 120, 300);
  let deals;
  try { deals = await listDeals({ all: true, me: "", status: "open" }); } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
  // Newest-touched first, so an active deal is refreshed even if we hit the cap.
  const total = deals.length;
  deals.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  const batch = deals.slice(0, limit);

  let processed = 0, ingested = 0;
  for (const d of batch) {
    try { ingested += await ingestDealEmails(d); } catch { /* one bad deal never sinks the run */ }
    processed++;
  }
  return NextResponse.json({ ok: true, openDeals: total, processed, ingested });
}
