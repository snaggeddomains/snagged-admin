// Internal endpoint the research app's "Add to Pipedrive" button POSTs to (owner-lookup /
// appraisal / whois / lead dossier surfaces). Auth = shared secret (x-internal-secret ==
// RESEARCH_INTERNAL_SECRET). NOTE: as of the native-CRM migration this creates a deal in
// OUR deals table (Pipedrive dropped) and fires the assignment notification. The path is
// kept for backward-compat with the research client; the button just makes a native deal.
// middleware.ts excludes api/internal.

import { NextResponse, type NextRequest } from "next/server";
import { createDeal, findDealByDomain, addActivity, type CreateDealInput } from "@/lib/deals/store";
import { setInquiryDismissed } from "@/lib/inquiries";
import { notifyAssignment, dealUrl } from "@/lib/deals/notify";
import { SOURCES } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authed(req: NextRequest): boolean {
  const secret = process.env.RESEARCH_INTERNAL_SECRET;
  return Boolean(secret) && req.headers.get("x-internal-secret") === secret;
}

// GET — drawer metadata for the research "Add to Pipedrive" form: the assignable owners
// (our app users; deal ownership is by our user email) + the Source/Channel labels.
export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // ?domain=<d> → does a deal already exist for it (so the button becomes "View deal")?
  const domain = new URL(req.url).searchParams.get("domain");
  let deal: { id: string; url: string; stage: string; status: string; owner_email: string | null } | null = null;
  if (domain) {
    try {
      const d = await findDealByDomain(domain);
      if (d) deal = { id: d.id, url: dealUrl(d.id), stage: d.stage, status: d.status, owner_email: d.owner_email };
    } catch { /* fail-open — no existing-deal info */ }
  }
  let assignees: { name: string; email: string }[] = [];
  try { assignees = await assignableUsers(); } catch { /* fail-open */ }
  return NextResponse.json({ ok: true, assignees, sources: [...SOURCES], deal });
}

export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown> & { assigneeEmail?: string };
  if (!b.domain || !b.source) {
    return NextResponse.json({ error: "domain and source are required" }, { status: 400 });
  }
  const input: CreateDealInput = {
    domain: String(b.domain),
    source: b.source ? String(b.source) : undefined,
    buyerName: b.buyerName ? String(b.buyerName) : undefined,
    buyerEmail: b.buyerEmail ? String(b.buyerEmail) : undefined,
    orgName: b.orgName ? String(b.orgName) : undefined,
    ownerEmail: b.assigneeEmail ? String(b.assigneeEmail) : undefined,
    budgetRange: b.budgetRange ? String(b.budgetRange) : undefined,
    heardAbout: b.heardAbout ? String(b.heardAbout) : undefined,
    notes: b.notes ? String(b.notes) : undefined,
    appraisalValue: b.appraisalValue != null && b.appraisalValue !== "" ? Number(b.appraisalValue) : undefined,
    askingPrice: b.askingPrice != null && b.askingPrice !== "" ? Number(b.askingPrice) : undefined,
    priority: b.priority ? String(b.priority) : undefined,
    reportLink: b.reportLink ? String(b.reportLink) : undefined,
    likelyOwner: b.likelyOwner ? String(b.likelyOwner) : undefined,
    ownerContact: b.ownerContact ? String(b.ownerContact) : undefined,
    reachability: b.reachability ? String(b.reachability) : undefined,
    additionalDomains: b.additionalDomains ? String(b.additionalDomains) : undefined,
    leadKey: b.leadKey ? String(b.leadKey) : undefined,
  };

  // Optional free-text pretext the research user typed in the Add-to-Deal drawer → posted as
  // the deal's first COMMENT (timeline), separate from the auto-filled Notes. Attributed to the
  // research user (actorEmail) when known.
  const comment = b.comment ? String(b.comment).trim() : "";
  const actorEmail = b.actorEmail ? String(b.actorEmail) : null;

  try {
    const { deal, created } = await createDeal(input);
    if (comment) {
      try { await addActivity(deal.id, { user_email: actorEmail, kind: "comment", body: comment, meta: null }); } catch { /* non-fatal */ }
    }
    // Converting the inquiry into a deal (from the research lead dossier) resolves it — auto-dismiss
    // the source lead so it drops off the Buy-Side Inquiries queue + the Inbox pointer count, the
    // same as the in-app triage convert. Best-effort; keyed off the lead_key the dossier passes.
    if (input.leadKey) {
      try { await setInquiryDismissed(input.leadKey, true, deal.owner_email || "research-dossier"); } catch { /* non-fatal */ }
    }
    const notified = created && deal.owner_email ? await notifyAssignment(deal, comment) : false;
    return NextResponse.json({ ok: true, dealId: deal.id, created, url: dealUrl(deal.id), notified });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 502 });
  }
}
