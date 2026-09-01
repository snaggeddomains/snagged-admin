// Per-card actions for the Owner Review queue (gated by `deals`).
//   POST {action}:
//     confirm  {patch?}         → upsert deal_owners + link the domain's deals + mark confirmed
//     edit     {patch}          → save reviewer edits to the candidate fields (stays pending)
//     reject                    → not a real seller / can't determine → terminal
//     skip                      → decide later (terminal until re-opened)
//     reopen                    → back to pending
//     reassign {assigned_to}    → hand the card to another reviewer

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import { confirmCard, updateCard, setCardStatus, reassignCard } from "@/lib/deals/owner-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function gate() {
  const me = await getCurrentUser();
  if (!me) return { me: null, err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return { me: null, err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  return { me, err: null };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { me, err } = await gate();
  if (err) return err;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "");
  const patch = (body.patch && typeof body.patch === "object" ? (body.patch as Record<string, unknown>) : body) as Record<string, unknown>;
  try {
    switch (action) {
      case "confirm": {
        const res = await confirmCard(id, patch, me!.email);
        return NextResponse.json({ ok: true, ...res });
      }
      case "edit":
        return NextResponse.json({ ok: true, card: await updateCard(id, patch, me!.email) });
      case "reject":
        return NextResponse.json({ ok: true, card: await setCardStatus(id, "rejected", me!.email) });
      case "skip":
        return NextResponse.json({ ok: true, card: await setCardStatus(id, "skipped", me!.email) });
      case "dismiss":
        return NextResponse.json({ ok: true, card: await setCardStatus(id, "dismissed", me!.email) });
      case "reopen":
        return NextResponse.json({ ok: true, card: await setCardStatus(id, "pending", me!.email) });
      case "reassign":
        return NextResponse.json({ ok: true, card: await reassignCard(id, String(body.assigned_to || "") || null) });
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
