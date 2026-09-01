// Manage one feature request (status / notes / fields) — Rob only (admin.feedback.manage).
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { updateFeedback } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canAdmin(me, "admin.feedback.manage")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const { id } = await params;
  const patch = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    return NextResponse.json({ ok: true, item: await updateFeedback(id, patch) });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
