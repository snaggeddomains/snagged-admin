// Clarification thread on one feature request.
//   GET  → the comments (access: manager || submitter || a participant).
//   POST {body, mentions[]} → add a comment (same access); tagged teammates + participants notified.
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { getFeedback, listComments, addComment, participantTicketIds } from "@/lib/feedback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Me = Awaited<ReturnType<typeof getCurrentUser>>;
async function canAccess(me: NonNullable<Me>, id: string): Promise<boolean> {
  if (canAdmin(me, "admin.feedback.manage")) return true;
  const fr = await getFeedback(id);
  if (fr && (fr.submitted_by || "").toLowerCase() === (me.email || "").toLowerCase()) return true;
  const parts = await participantTicketIds(me.email);
  return parts.includes(id);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  try {
    if (!(await canAccess(me, id))) return NextResponse.json({ error: "No access" }, { status: 403 });
    return NextResponse.json({ ok: true, comments: await listComments(id) });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { body?: string; mentions?: string[] };
  try {
    if (!(await canAccess(me, id))) return NextResponse.json({ error: "No access" }, { status: 403 });
    const comment = await addComment(
      id,
      { body: body.body, mentions: body.mentions },
      { email: me.email, name: [me.first_name, me.last_name].filter(Boolean).join(" ") || null },
    );
    return NextResponse.json({ ok: true, comment });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 400 });
  }
}
