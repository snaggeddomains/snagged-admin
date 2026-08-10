// SEO report API (gated reports.seo): GET the live report; POST to manage the
// action loop + target keywords + trigger a snapshot.
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { buildSeoReport, snapshotWeek } from "@/lib/seo/report";
import { upsertAction, upsertTarget, deactivateTarget } from "@/lib/seo/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET() {
  const user = await getCurrentUser();
  if (!user || !canReports(user, "reports.seo")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const report = await buildSeoReport();
    return NextResponse.json({ ok: true, report });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user || !canReports(user, "reports.seo")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const actor = String(user.email || "").toLowerCase();
  try {
    switch (body.action) {
      case "add_action":
      case "update_action":
        await upsertAction(body.item || {}, actor);
        return NextResponse.json({ ok: true });
      case "add_target":
        if (!body.item?.keyword) return NextResponse.json({ error: "keyword required" }, { status: 400 });
        await upsertTarget(body.item);
        return NextResponse.json({ ok: true });
      case "remove_target":
        if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await deactivateTarget(body.id);
        return NextResponse.json({ ok: true });
      case "snapshot": {
        const r = await snapshotWeek();
        return NextResponse.json({ ok: true, ...r });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
