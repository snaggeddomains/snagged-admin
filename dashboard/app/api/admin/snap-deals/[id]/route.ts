// SNAP Deal detail — GET (deal + progress log), PATCH (edit fields / move stage / mark
// won|dropped), POST (add a progress note), DELETE. Single `snap.deals` gate throughout.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { getSnapDeal, updateSnapDeal, deleteSnapDeal, addSnapActivity, listSnapActivity } from "@/lib/snap-deals/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate() {
  const me = await getCurrentUser();
  if (!me) return { err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!userCan(me, "snap.deals")) return { err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  return { me };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(); if (g.err) return g.err;
  const { id } = await params;
  try {
    const deal = await getSnapDeal(id);
    if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const activity = await listSnapActivity(id);
    return NextResponse.json({ ok: true, deal, activity });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(); if (g.err) return g.err;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const deal = await updateSnapDeal(id, { ...body, actor: g.me!.email });
    return NextResponse.json({ ok: true, deal });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(); if (g.err) return g.err;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { action?: string; body?: string };
  if (body.action !== "note") return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const text = String(body.body || "").trim();
  if (!text) return NextResponse.json({ error: "empty note" }, { status: 400 });
  try {
    await addSnapActivity(id, { user_email: g.me!.email, kind: "note", body: text });
    return NextResponse.json({ ok: true, activity: await listSnapActivity(id) });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate(); if (g.err) return g.err;
  const { id } = await params;
  try {
    await deleteSnapDeal(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
