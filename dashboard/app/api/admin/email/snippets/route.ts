// Email snippets CRUD — reusable boilerplate for the Email tools (Compose / Follow-up). Gated by the
// `email` module permission. Shared across the team; fail-soft on the missing table (returns []).

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listSnippets, saveSnippet, deleteSnippet } from "@/lib/email-snippets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });
  return NextResponse.json({ ok: true, snippets: await listSnippets() });
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "email")) return NextResponse.json({ error: "No access" }, { status: 403 });
  let body: { action?: string; id?: string; title?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  try {
    if (body.action === "delete") {
      if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
      await deleteSnippet(body.id);
      return NextResponse.json({ ok: true });
    }
    // default = save (create or update)
    const row = await saveSnippet({ id: body.id, title: body.title || "", body: body.body || "" }, me.email);
    if (!row) return NextResponse.json({ error: "Snippets aren't set up yet — run scripts/email_snippets.sql." }, { status: 503 });
    return NextResponse.json({ ok: true, snippet: row });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
