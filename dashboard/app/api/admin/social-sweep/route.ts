// Social Sweep report API. GET → scored posts (high-signal by default) + freshness
// health; POST → dismiss/restore a post. Gated by reports.social_sweep.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { listPosts, setPostDismissed, recentSweepRuns } from "@/lib/reddit-sweep/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReports(user, "reports.social_sweep")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const p = req.nextUrl.searchParams;
  const platform = p.get("platform") || undefined; // reddit | x | (all)
  const includeMaybe = p.get("maybe") === "1";
  const includeDismissed = p.get("dismissed") === "1";

  const [posts, runs] = await Promise.all([
    listPosts({ platform, includeMaybe, includeDismissed }),
    recentSweepRuns(20),
  ]);

  const last = runs[0] || null;
  const lastAgeH = last ? (Date.now() - new Date(last.run_at).getTime()) / 3_600_000 : null;
  const health = {
    lastRunAt: last?.run_at || null,
    lastOk: last?.ok ?? null,
    feedErrors: last?.feed_errors || [],
    status: !last ? "yellow" : !last.ok ? "red" : (lastAgeH != null && lastAgeH > 30 ? "yellow" : "green"),
    error: last?.error || null,
  };

  return NextResponse.json({ posts, health });
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canReports(user, "reports.social_sweep")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; id?: string; dismissed?: boolean };
  if (body.action === "dismiss" && body.id) {
    const ok = await setPostDismissed(body.id, body.dismissed !== false);
    return NextResponse.json({ ok });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
