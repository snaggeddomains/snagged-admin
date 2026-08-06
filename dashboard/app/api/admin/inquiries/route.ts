// Buy-side triage queue API. GET lists the enriched inbound inquiries; POST converts
// one into a NATIVE deal (human-triggered — Rob's discretion). Gated by the
// research.pipedrive permission (admins auto-pass). Convert = createDeal + the deal
// assignment notification, landing the inquiry on the Deals board.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { listBuyInquiries, setInquiryDismissed } from "@/lib/inquiries";
import { createDeal, addActivity, type CreateDealInput } from "@/lib/deals/store";
import { notifyAssignment, dealUrl } from "@/lib/deals/notify";
import { SOURCES } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";

// Drawer metadata (assignable owners = "can receive deals" users, by name + Source labels).
async function convertMeta(): Promise<{ assignees: { name: string; email: string }[]; sources: string[] }> {
  let assignees: { name: string; email: string }[] = [];
  try { assignees = await assignableUsers(); } catch { /* fail-open */ }
  return { assignees, sources: [...SOURCES] };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "research.pipedrive")) return NextResponse.json({ error: "No access" }, { status: 403 });
  const url = new URL(req.url);
  const includeSell = url.searchParams.get("all") === "1";
  const includeDismissed = url.searchParams.get("dismissed") === "1";
  const q = url.searchParams.get("q") || "";
  try {
    const [data, meta] = await Promise.all([listBuyInquiries({ includeSell, includeDismissed, q }), convertMeta()]);
    return NextResponse.json({ ok: true, ...data, meta });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCan(me, "research.pipedrive")) return NextResponse.json({ error: "No access" }, { status: 403 });

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown> & { assigneeEmail?: string; action?: string; leadKey?: string };

  // Dismiss / restore an inquiry (spam or test entry) — a distinct action.
  if (b.action === "dismiss" || b.action === "undismiss") {
    if (!b.leadKey) return NextResponse.json({ error: "leadKey required" }, { status: 400 });
    try { await setInquiryDismissed(String(b.leadKey), b.action === "dismiss", me.email); return NextResponse.json({ ok: true }); }
    catch (e) { return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 }); }
  }

  if (!b.domain || !b.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }
  const input: CreateDealInput = {
    domain: String(b.domain),
    source: String(b.source),
    buyerName: b.buyerName ? String(b.buyerName) : undefined,
    buyerEmail: b.buyerEmail ? String(b.buyerEmail) : undefined,
    orgName: b.orgName ? String(b.orgName) : undefined,
    ownerEmail: b.assigneeEmail ? String(b.assigneeEmail) : undefined,
    budgetRange: b.budgetRange ? String(b.budgetRange) : undefined,
    heardAbout: b.heardAbout ? String(b.heardAbout) : undefined,
    notes: b.notes ? String(b.notes) : undefined,
    priority: b.priority ? String(b.priority) : undefined,
    additionalDomains: b.additionalDomains ? String(b.additionalDomains) : undefined,
    reportLink: b.reportLink ? String(b.reportLink) : undefined,
    leadKey: b.leadKey ? String(b.leadKey) : undefined,
    createdBy: me.email,
  };
  try {
    const { deal, created } = await createDeal(input);
    // A triage comment (optional) → the deal's first note on the timeline.
    const comment = b.comment ? String(b.comment).trim() : "";
    if (comment) await addActivity(deal.id, { user_email: me.email, kind: "comment", body: comment, meta: { via: "triage" } });
    // Converting an inquiry into a deal resolves it — auto-dismiss so it drops off the
    // active triage queue (still visible under "Show dismissed"). Best-effort.
    if (b.leadKey) { try { await setInquiryDismissed(String(b.leadKey), true, me.email); } catch { /* non-fatal */ } }
    const notified = created && deal.owner_email ? await notifyAssignment(deal, comment) : false;
    return NextResponse.json({ ok: true, dealId: deal.id, created, url: dealUrl(deal.id), notified, dismissed: !!b.leadKey });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 502 });
  }
}
