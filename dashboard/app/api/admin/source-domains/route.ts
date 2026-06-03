// Returns the domains a source added "new today" (feed-new list if persisted,
// else net-new-to-universe), each with its enrichment state — backs the
// expandable "new today" drill-down on the admin sources dashboard.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { listNewTodayDomains } from "@/lib/new-today";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const source = req.nextUrl.searchParams.get("source")?.trim();
  if (!source) return NextResponse.json({ error: "Missing source" }, { status: 400 });

  try {
    const result = await listNewTodayDomains(source);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
