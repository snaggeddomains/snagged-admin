// Auto email ingestion — pulls the relevant Gmail threads onto each OPEN deal so the
// deal module + each deal stay current without anyone clicking "Pull emails". Runs
// every 4h. Auth: CRON_SECRET. Bounded to stay within the SHARED per-user Gmail quota
// (the mailbox owner's own client — Superhuman — draws on the same per-user budget, so
// we deliberately DON'T re-pull every open deal every run): ACTIVE deals (touched in
// the last ACTIVE_DAYS) sync every run; IDLE deals rotate over the 6 daily runs so each
// still refreshes ~once/day. The manual "Pull emails" button + on-open ingest cover
// anything more urgent.
//   ?limit=N  cap deals processed this run (default 120).
//   ?full=1   ignore the activity gate and re-sync every open deal (manual backfill).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { gmailConfigured } from "@/lib/gmail";
import { listDeals, updateDeal, dealsConfigured } from "@/lib/deals/store";
import { ingestDealEmails } from "@/lib/deals/emails";
import { researchReportLink } from "@/lib/deals/research-link";
import { recordHeartbeat } from "@/lib/cron-heartbeat";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!dealsConfigured() || !gmailConfigured()) return NextResponse.json({ ok: true, skipped: "deals or gmail not configured" });

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit")) || 120, 300);
  const full = url.searchParams.get("full") === "1"; // manual backfill: re-sync ALL open deals
  let deals;
  try { deals = await listDeals({ all: true, me: "", status: "open" }); } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
  const total = deals.length;
  // Newest-touched first, so an active deal is refreshed even if we hit the cap.
  deals.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));

  // Quota-aware selection (see header): ACTIVE deals every run, IDLE deals rotate
  // over the 6 daily runs (stable per-deal bucket) so each still refreshes ~1×/day.
  const ACTIVE_DAYS = 21;
  const activeCut = Date.now() - ACTIVE_DAYS * 864e5;
  const runBucket = Math.floor(new Date().getUTCHours() / 4) % 6; // runs at :15 of hrs 0,4,8,12,16,20
  const bucketOf = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 6; };
  const selected = full ? deals : deals.filter((d) => {
    const t = Date.parse(d.updated_at || "");
    if (Number.isFinite(t) && t >= activeCut) return true; // active → every run
    return bucketOf(d.id) === runBucket;                   // idle → ~once/day
  });
  const batch = selected.slice(0, limit);

  let processed = 0, ingested = 0, linked = 0;
  for (const d of batch) {
    try { ingested += await ingestDealEmails(d); } catch { /* one bad deal never sinks the run */ }
    // Auto-link the Domain Owner report for this domain if one exists + isn't linked yet.
    if (!d.report_link) {
      try {
        const link = await researchReportLink(d.domain);
        if (link) { await updateDeal(d.id, { report_link: link }, null); linked++; }
      } catch { /* best-effort */ }
    }
    processed++;
  }
  // Heartbeat so the UI can show "emails auto-synced N min ago" — proof the cron fired.
  await recordHeartbeat("deal-emails", { openDeals: total, selected: batch.length, processed, ingested, linked });
  return NextResponse.json({ ok: true, openDeals: total, selected: batch.length, processed, ingested, linked });
}
