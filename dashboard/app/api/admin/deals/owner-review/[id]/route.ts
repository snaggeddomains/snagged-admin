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
import { confirmCard, updateCard, setCardStatus, reassignCard, getCard } from "@/lib/deals/owner-review";
import { resolveNameFromThread, mineOwnerForDomain } from "@/lib/deals/owner-review-mine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
      case "remine": {
        // Re-run the acquisition-email miner for this domain (whole-thread read + direction-aware
        // LLM) and OVERWRITE the candidate fields — for a card mined before the miner improved, or
        // one that looks wrong. Stays pending. maxDuration 60 covers the multi-thread read.
        const card = await getCard(id);
        if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
        const mined = await mineOwnerForDomain(card.domain);
        const updated = await updateCard(id, {
          candidate_first_name: mined.first_name || "",
          candidate_last_name: mined.last_name || "",
          candidate_email: mined.email || "",
          candidate_phone: mined.phone || "",
          channel: mined.channel || "",
          buyer_context: mined.buyer_context || "",
          confidence: mined.confidence,
          evidence: mined.evidence || "",
        }, me!.email);
        return NextResponse.json({ ok: true, remined: mined.seller_found, card: updated });
      }
      case "resolve_name": {
        // Pull the seller's FULL name from the deal-mailbox thread headers (display name on their email).
        const card = await getCard(id);
        if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
        const email = String(body.email || card.candidate_email || "");
        if (!email) return NextResponse.json({ error: "no email on this card to look up" }, { status: 400 });
        const hit = await resolveNameFromThread(card.domain, email);
        if (!hit || !hit.full) return NextResponse.json({ ok: true, resolved: false, card });
        const updated = await updateCard(id, { candidate_first_name: hit.first, candidate_last_name: hit.last }, me!.email);
        return NextResponse.json({ ok: true, resolved: true, full: hit.full, card: updated });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
