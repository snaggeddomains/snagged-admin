// Daily corpus rebuild: aggregates client domains from the tracker (Payments +
// Master Txns), Full Opportunity, Gmail, and DomainScout into the client_domains
// table + mirrors them to the Client Domain Names sheet. Runs BEFORE the overlap
// matcher so the corpus is fresh when it reads.
//
// Auth: CRON_SECRET (Vercel bearer).
//   ?gmailDays=N   Gmail lookback window (default 30; use a large value ONCE for the
//                  initial backfill, e.g. ?gmailDays=1000).
//   ?skipGmail=1   skip the Gmail source (structured sources only).
//   ?skipMirror=1  skip the Google Sheet mirror (DB only).

import { NextResponse, type NextRequest } from "next/server";
import { authorizedCron } from "@/lib/orchestrator";
import { buildCorpus } from "@/lib/domain-corpus/build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const p = req.nextUrl.searchParams;
  const gmailDays = Math.min(Math.max(parseInt(p.get("gmailDays") || "30", 10) || 30, 1), 3650);
  const skipGmail = p.get("skipGmail") === "1";
  const skipMirror = p.get("skipMirror") === "1";
  const prune = p.get("prune") === "1"; // scrub bulk-list (NameJet/Catches) pollution

  const stats = await buildCorpus({ gmailDays, skipGmail, skipMirror, prune });
  return NextResponse.json(stats, { status: stats.ok ? 200 : 500 });
}
