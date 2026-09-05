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
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One-click classification presets. `owner` = confirm the card to a SHARED canonical owner (so every
// card tagged the same preset links to ONE owner record — edit that owner's contact once and it
// cascades to all of them). `dismiss` = a no-owner terminal disposition (drop/registration/platform).
const QUICK_PRESETS: Record<string, { type: "owner" | "dismiss"; ownerName?: string; first?: string; last?: string; company?: string; email?: string; channel: string; confidence?: string; note?: string }> = {
  namecheap:     { type: "owner", ownerName: "NameCheap Inc", company: "Namecheap", channel: "Namecheap Market / portfolio", confidence: "high" },
  godaddy_jason: { type: "owner", ownerName: "Jason Villalobos", first: "Jason", last: "Villalobos", email: "jxvillalobos@godaddy.com", company: "GoDaddy", channel: "GoDaddy broker (Jason)", confidence: "high" },
  drop:          { type: "dismiss", channel: "DropCatch auction", note: "Caught from a drop — no prior owner to record." },
  auction:       { type: "dismiss", channel: "Auction", note: "Bought at auction (GoDaddy/NameJet/Sedo/etc.) — no prior owner to record." },
  platform:      { type: "dismiss", channel: "Marketplace platform", note: "Purchased directly from a marketplace platform — no individual seller." },
};

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
        // link_owner_id (from the "Link to an existing owner" typeahead) groups the card with that owner.
        const linkOwnerId = body.link_owner_id ? String(body.link_owner_id) : null;
        const res = await confirmCard(id, patch, me!.email, linkOwnerId);
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
      case "quicktag": {
        // One-click classify (Namecheap portfolio / Jason·GoDaddy / caught-from-drop / direct-from-platform).
        const p = QUICK_PRESETS[String(body.preset || "")];
        if (!p) return NextResponse.json({ error: "Unknown preset" }, { status: 400 });
        if (p.type === "owner") {
          // Confirm to the SHARED canonical owner (findOwner matches by name/email → all such cards link
          // to one record; editing that owner's contact cascades to every card in the portfolio).
          const res = await confirmCard(id, {
            candidate_name: p.ownerName || "", candidate_first_name: p.first || "", candidate_last_name: p.last || "",
            candidate_company: p.company || "", candidate_email: p.email || "", channel: p.channel, confidence: p.confidence || "high",
          }, me!.email);
          return NextResponse.json({ ok: true, ...res });
        }
        // dismiss preset: record the channel/reason, then mark dismissed (no owner to log). A specific
        // platform (Atom/Spaceship/Afternic/…) can be passed to name the exact channel.
        const platform = body.platform ? String(body.platform).trim() : "";
        const channel = platform || p.channel;
        const note = platform ? `Purchased directly from ${platform} — no individual seller.` : (p.note || "");
        await updateCard(id, { channel, confidence: "none", notes: note }, me!.email);
        return NextResponse.json({ ok: true, card: await setCardStatus(id, "dismissed", me!.email) });
      }
      case "remine": {
        // Re-run the acquisition-email miner for this domain (whole-thread read + direction-aware
        // LLM) and OVERWRITE the candidate fields — for a card mined before the miner improved, or
        // one that looks wrong. Stays pending. maxDuration 60 covers the multi-thread read.
        const card = await getCard(id);
        if (!card) return NextResponse.json({ error: "card not found" }, { status: 404 });
        const mined = await withGmailFeature("owner-review-remine", () => mineOwnerForDomain(card.domain));
        const updated = await updateCard(id, {
          candidate_first_name: mined.first_name || "",
          candidate_last_name: mined.last_name || "",
          candidate_email: mined.email || "",
          candidate_phone: mined.phone || "",
          candidate_company: mined.company || "",
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
        const hit = await withGmailFeature("owner-review-remine", () => resolveNameFromThread(card.domain, email));
        if (!hit || !hit.full) return NextResponse.json({ ok: true, resolved: false, card });
        const updated = await updateCard(id, { candidate_first_name: hit.first, candidate_last_name: hit.last }, me!.email);
        return NextResponse.json({ ok: true, resolved: true, full: hit.full, card: updated });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (isGmailBudgetError(e)) return NextResponse.json({ ok: false, budgetPaused: true, error: GMAIL_BUDGET_MESSAGE }, { status: 429 });
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
