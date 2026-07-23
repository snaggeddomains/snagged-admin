// Owner intelligence directory API — gated by the `deals` module (same as the board).
//   GET                → list owners (+ deal counts). ?q= filters; ?typeahead= light list.
//   GET ?id=<id>       → one owner + every deal we've worked with them.
//   POST {action}      → save (create/update), confirm (find-or-create + link a deal),
//                        link / unlink a deal ↔ owner.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction } from "@/lib/permissions";
import {
  ownersConfigured, listOwners, getOwner, ownerDeals, createOwner, updateOwner,
  confirmOwnerForDeal, linkDealOwner, searchOwnersTypeahead, type OwnerInput,
} from "@/lib/deals/owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function gate() {
  const me = await getCurrentUser();
  if (!me) return { me: null, err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return { me: null, err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  return { me, err: null };
}

export async function GET(req: NextRequest) {
  const { me, err } = await gate();
  if (err) return err;
  if (!ownersConfigured()) return NextResponse.json({ ok: true, configured: false, owners: [] });
  const url = new URL(req.url);
  try {
    const typeahead = url.searchParams.get("typeahead");
    if (typeahead != null) return NextResponse.json({ ok: true, owners: await searchOwnersTypeahead(typeahead) });
    const id = url.searchParams.get("id");
    if (id) {
      const owner = await getOwner(id);
      if (!owner) return NextResponse.json({ error: "Not found" }, { status: 404 });
      const deals = await ownerDeals(id);
      return NextResponse.json({ ok: true, configured: true, owner, deals, me: me!.email });
    }
    const owners = await listOwners({ q: url.searchParams.get("q") || undefined });
    return NextResponse.json({ ok: true, configured: true, owners, me: me!.email });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const { me, err } = await gate();
  if (err) return err;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const action = String(body.action || "save");
  try {
    switch (action) {
      case "save": {
        const input = body as OwnerInput & { id?: string };
        if (input.id) return NextResponse.json({ ok: true, owner: await updateOwner(input.id, body, me!.email) });
        return NextResponse.json({ ok: true, owner: await createOwner(input, me!.email) });
      }
      case "confirm": {
        const dealId = String(body.deal_id || "");
        if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });
        if (!String(body.name || "").trim() && !body.owner_id) return NextResponse.json({ error: "owner name required" }, { status: 400 });
        const owner = await confirmOwnerForDeal(dealId, body as OwnerInput & { negotiation_append?: string | null; owner_id?: string | null }, me!.email);
        return NextResponse.json({ ok: true, owner });
      }
      case "link": {
        const dealId = String(body.deal_id || ""), ownerId = String(body.owner_id || "");
        if (!dealId || !ownerId) return NextResponse.json({ error: "deal_id + owner_id required" }, { status: 400 });
        await linkDealOwner(dealId, ownerId);
        return NextResponse.json({ ok: true });
      }
      case "unlink": {
        const dealId = String(body.deal_id || "");
        if (!dealId) return NextResponse.json({ error: "deal_id required" }, { status: 400 });
        await linkDealOwner(dealId, null);
        return NextResponse.json({ ok: true });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
