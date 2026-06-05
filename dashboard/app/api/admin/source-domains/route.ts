// Backs the expandable count drill-down on the admin sources dashboard. For SNAP/
// aux sources it returns the domains added "new today" (feed-new list if
// persisted, else net-new-to-universe) with enrichment state. For auction sources
// (?kind=auctions) it returns the current LIVE auctions from snapshot.json — those
// names deliberately never enter the universe, so they have no enrichment.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listNewTodayDomains, listLiveAuctions } from "@/lib/new-today";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const source = req.nextUrl.searchParams.get("source")?.trim();
  if (!source) return NextResponse.json({ error: "Missing source" }, { status: 400 });
  const kind = req.nextUrl.searchParams.get("kind")?.trim();

  try {
    if (kind === "auctions") {
      const result = await listLiveAuctions(source);
      return NextResponse.json({ ok: true, kind: "auctions", ...result });
    }
    const result = await listNewTodayDomains(source);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
