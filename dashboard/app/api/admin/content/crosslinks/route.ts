// Content cross-linking API — the ranked internal-link opportunities + feedback. Gated by
// `reports.content`. Analyze is a heavy LLM pass (one call per post) run inline; feedback is a
// light upsert that trains future runs.
//
//   GET                         → latest run + its opportunities (feedback merged) + config flags
//   POST {action:'analyze'}     → run the analysis (heavy) → {runId, posts, opportunities}
//   POST {action:'feedback', source_id, target_id, rating:'up'|'down', note?}
//   POST {action:'dismiss', id} → hide one opportunity

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import {
  crosslinksConfigured, analyzeCrosslinks, latestRun, listOpportunities, listFeedback,
  upsertFeedback, setOpportunityStatus,
} from "@/lib/content/crosslinks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // the Analyze pass makes one LLM call per post

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.content")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!crosslinksConfigured()) {
    return NextResponse.json({ ok: true, configured: false, run: null, opportunities: [] });
  }
  const run = await latestRun();
  if (!run) return NextResponse.json({ ok: true, configured: true, run: null, opportunities: [] });
  const [opps, fb] = await Promise.all([listOpportunities(run.id), listFeedback()]);
  const fbMap = new Map(fb.map((f) => [`${f.source_id}|${f.target_id}`, f.rating]));
  // Normalize any 0-1 scores an earlier run may have stored to the 0-100 scale, then re-rank.
  const norm = (s: number | null): number | null => s == null ? s : (s > 0 && s <= 1 ? Math.round(s * 100) : Math.round(s));
  const merged = opps
    .filter((o) => o.status !== "dismissed" && fbMap.get(`${o.source_id}|${o.target_id}`) !== "down")
    .map((o) => ({ ...o, score: norm(Number(o.score)), feedback: fbMap.get(`${o.source_id}|${o.target_id}`) || null }))
    .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return NextResponse.json({ ok: true, configured: true, run, opportunities: merged });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.content")) return NextResponse.json({ error: "No access" }, { status: 403 });
  if (!crosslinksConfigured()) return NextResponse.json({ error: "Not configured (need Webflow + ANTHROPIC_API_KEY + WEBFLOW_BLOG_POSTS_ID)" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; source_id?: string; target_id?: string; rating?: string; note?: string; id?: string };
  try {
    switch (body.action) {
      case "analyze": {
        const r = await analyzeCrosslinks(me.email);
        return NextResponse.json({ ok: true, ...r });
      }
      case "feedback": {
        if (!body.source_id || !body.target_id || (body.rating !== "up" && body.rating !== "down")) return NextResponse.json({ error: "source_id + target_id + rating(up|down) required" }, { status: 400 });
        await upsertFeedback(body.source_id, body.target_id, body.rating, body.note || null, me.email);
        return NextResponse.json({ ok: true });
      }
      case "dismiss": {
        if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await setOpportunityStatus(body.id, "dismissed");
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
