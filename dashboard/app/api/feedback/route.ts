// Feedback / Feature Requests API.
//   GET ?scope=mine|all&status=&q=  — mine (any user, their own) / all (Rob only, the queue).
//   POST {module,kind,title,body}   — submit (any logged-in user); alerts rob@ only.
// Managing (status/notes, the whole queue) is gated by admin.feedback.manage (admins auto-pass).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { feedbackConfigured, listFeedback, createFeedback, feedbackModules } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const canManage = canAdmin(me, "admin.feedback.manage");
  if (!feedbackConfigured()) return NextResponse.json({ ok: true, configured: false, items: [], canManage, modules: feedbackModules(), me: me.email });
  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || (canManage ? "all" : "mine");
  try {
    // Only Rob sees the whole queue; everyone else is forced to their own submissions.
    const items = scope === "all" && canManage
      ? await listFeedback({ status: url.searchParams.get("status") || undefined, q: url.searchParams.get("q") || undefined })
      : await listFeedback({ mine: me.email });
    return NextResponse.json({ ok: true, configured: true, items, canManage, modules: feedbackModules(), me: me.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const item = await createFeedback(
      { module: String(body.module || ""), kind: String(body.kind || ""), title: String(body.title || ""), body: String(body.body || "") },
      { email: me.email, name: [me.first_name, me.last_name].filter(Boolean).join(" ") || null },
    );
    return NextResponse.json({ ok: true, item });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
