// One deal: detail (with activity + ingested emails), field/stage/owner/status updates,
// and actions (add a comment w/ @mentions, ingest emails, move on the board). Gated by
// the `deals` module; a non-deals.all user can only touch their own deals or the Inbox.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction, type AppUser } from "@/lib/permissions";
import { getDeal, updateDeal, addActivity, listActivity, listDealEmails, type Deal } from "@/lib/deals/store";
import { notifyAssignment, notifyStageChange, notifyMention } from "@/lib/deals/notify";
import { ingestDealEmails } from "@/lib/deals/emails";
import { isStage } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

// May this user act on this deal? deals.all / admin → any; their own → yes; an unassigned
// Inbox deal → only if they hold deals.inbox (so they can claim it).
function mayTouch(me: AppUser, deal: Deal): boolean {
  if (me.is_admin || userCanAction(me, "deals.all")) return true;
  if (deal.owner_email) return deal.owner_email.toLowerCase() === me.email.toLowerCase();
  return userCanAction(me, "deals.inbox");
}

async function gate(_req: NextRequest): Promise<{ me: AppUser | null; err: NextResponse | null }> {
  const me = await getCurrentUser();
  if (!me) return { me: null, err: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) };
  if (!userCan(me, "deals") && !userCanAction(me, "deals.all")) return { me: null, err: NextResponse.json({ error: "No access" }, { status: 403 }) };
  return { me, err: null };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const { me, err } = await gate(req);
  if (err) return err;
  const deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayTouch(me!, deal)) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });
  const [activity, emails, assignees] = await Promise.all([listActivity(deal.id), listDealEmails(deal.id), assignableUsers()]);
  return NextResponse.json({ ok: true, deal, activity, emails, assignees, me: me!.email });
}

const EDITABLE = new Set([
  "domain", "additional_domains", "buyer_name", "buyer_email", "buyer_phone", "org_name",
  "budget_range", "appraisal_value", "asking_price", "sale_price", "commission", "source", "priority", "owner_email",
  "stage", "status", "lost_reason", "report_link", "likely_owner", "owner_contact",
  "reachability", "notes", "tags", "position",
]);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { me, err } = await gate(req);
  if (err) return err;
  const deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayTouch(me!, deal)) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (EDITABLE.has(k)) patch[k] = v;
  if (patch.stage !== undefined && typeof patch.stage === "string" && !isStage(patch.stage)) {
    return NextResponse.json({ error: "Unknown stage" }, { status: 400 });
  }
  if (patch.owner_email !== undefined && patch.owner_email) patch.owner_email = String(patch.owner_email).toLowerCase();
  if (!Object.keys(patch).length) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const updated = await updateDeal(params.id, patch, me!.email);
  // Fire notifications for the meaningful transitions.
  if (patch.owner_email !== undefined && (updated.owner_email || null) !== (deal.owner_email || null) && updated.owner_email) {
    await notifyAssignment(updated);
  }
  if (patch.stage !== undefined && updated.stage !== deal.stage) {
    await notifyStageChange(updated, deal.stage, me!.email);
  }
  return NextResponse.json({ ok: true, deal: updated });
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const { me, err } = await gate(req);
  if (err) return err;
  const deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayTouch(me!, deal)) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; body?: string; mentions?: string[] };
  switch (body.action) {
    case "comment": {
      const text = String(body.body || "").trim();
      if (!text) return NextResponse.json({ error: "Empty comment" }, { status: 400 });
      const mentions = Array.isArray(body.mentions) ? body.mentions.filter(Boolean) : [];
      const act = await addActivity(deal.id, { user_email: me!.email, kind: "comment", body: text, meta: mentions.length ? { mentions } : null });
      if (mentions.length) await notifyMention(deal, mentions, me!.email, text);
      return NextResponse.json({ ok: true, activity: act });
    }
    case "note": {
      const text = String(body.body || "").trim();
      if (!text) return NextResponse.json({ error: "Empty note" }, { status: 400 });
      const mentions = Array.isArray(body.mentions) ? body.mentions.filter(Boolean) : [];
      const act = await addActivity(deal.id, { user_email: me!.email, kind: "note", body: text, meta: mentions.length ? { mentions } : null });
      if (mentions.length) await notifyMention(deal, mentions, me!.email, text);
      return NextResponse.json({ ok: true, activity: act });
    }
    case "ingest": {
      const count = await ingestDealEmails(deal);
      const emails = await listDealEmails(deal.id);
      return NextResponse.json({ ok: true, ingested: count, emails });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
