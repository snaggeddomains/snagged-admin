// One deal: detail (with activity + ingested emails), field/stage/owner/status updates,
// and actions (add a comment w/ @mentions, ingest emails, move on the board). Gated by
// the `deals` module; a non-deals.all user can only touch their own deals or the Inbox.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction, type AppUser } from "@/lib/permissions";
import { getDeal, updateDeal, addActivity, listActivity, listDealEmails, type Deal } from "@/lib/deals/store";
import { notifyAssignment, notifyStageChange, notifyMention } from "@/lib/deals/notify";
import { ingestDealEmails } from "@/lib/deals/emails";
import { researchReportLink, kickResearchRun, researchReportSummary } from "@/lib/deals/research-link";
import { isStage } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";
import { getOwner } from "@/lib/deals/owners";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

// Base for the research app's inbound-lead dossier deep-link (#/lead/<key>).
const RESEARCH_APP_BASE = (process.env.RESEARCH_APP_BASE || "https://app.snagged.com/research").replace(/\/+$/, "");

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
  let deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayTouch(me!, deal)) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });
  // Rule: if a Domain Owner report has been run for this exact domain, auto-link it.
  // Fill (once) when the deal has no report link yet + a run exists. If NO run exists
  // yet (e.g. a manually-added deal for a domain we've never researched), kick a FREE
  // pre-flight report so the link auto-fills on a later view — no button, no waiting.
  if (!deal.report_link) {
    const link = await researchReportLink(deal.domain);
    if (link) { try { deal = await updateDeal(deal.id, { report_link: link }, null); } catch { /* keep unlinked */ } }
    else { await kickResearchRun(deal.domain); }
  }
  // Once research/appraisal has run, pull its structured findings into the sidebar so they
  // don't have to be typed by hand. Fills ONLY still-empty fields (a manual edit always wins).
  if (deal.report_link && (!deal.likely_owner || !deal.owner_contact || deal.appraisal_value == null)) {
    const s = await researchReportSummary(deal.domain);
    if (s) {
      const patch: Record<string, unknown> = {};
      if (!deal.likely_owner && s.likely_owner) patch.likely_owner = s.likely_owner;
      if (!deal.owner_contact && s.owner_contact) patch.owner_contact = s.owner_contact;
      if (deal.appraisal_value == null && s.appraisal && s.appraisal.mid > 0) patch.appraisal_value = Math.round(s.appraisal.mid);
      if (Object.keys(patch).length) { try { deal = await updateDeal(deal.id, patch, null); } catch { /* keep as-is */ } }
    }
  }
  const dossierUrl = deal.lead_key ? `${RESEARCH_APP_BASE}/#/lead/${deal.lead_key}` : null;
  // A deal can name several domains — resolve a research report for EACH additional domain too
  // (kick a free pre-flight for any we haven't researched), so each links its own report.
  const addlDomains = String(deal.additional_domains || "")
    .split(/[,;\s]+/).map((d) => d.trim().toLowerCase()).filter((d) => d.includes("."));
  const additional = await Promise.all([...new Set(addlDomains)].map(async (d) => {
    const report = await researchReportLink(d);
    if (!report) await kickResearchRun(d); // fills on a later view
    return { domain: d, report };
  }));
  const [activity, emails, assignees] = await Promise.all([listActivity(deal.id), listDealEmails(deal.id), assignableUsers()]);
  // The confirmed owner record (built at Negotiating), for the sidebar link + directory.
  let ownerRecord: { id: string; name: string } | null = null;
  if (deal.domain_owner_id) { try { const o = await getOwner(deal.domain_owner_id); if (o) ownerRecord = { id: o.id, name: o.name }; } catch { /* best-effort */ } }
  return NextResponse.json({ ok: true, deal, dossierUrl, additional, ownerRecord, activity, emails, assignees, me: me!.email });
}

const EDITABLE = new Set([
  "domain", "additional_domains", "buyer_name", "buyer_email", "buyer_phone", "org_name",
  "budget_range", "appraisal_value", "asking_price", "sale_price", "commission", "upfront_fee", "upfront_paid", "source", "priority", "owner_email",
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
  // Editing the PRIMARY domain (e.g. the client now wants electron.ai, not electron.net):
  // normalize it, and — since the linked report/owner/appraisal were for the OLD name —
  // reset those derived fields so the GET re-links + re-fills + kicks research for the new
  // domain. (A blank/unchanged domain is left alone.)
  if (patch.domain !== undefined) {
    const nd = String(patch.domain || "").trim().toLowerCase();
    if (!nd || !nd.includes(".")) { delete patch.domain; }
    else if (nd !== String(deal.domain || "").toLowerCase()) {
      patch.domain = nd;
      patch.report_link = null;
      patch.likely_owner = null;
      patch.owner_contact = null;
      patch.appraisal_value = null;
    } else { delete patch.domain; }
  }
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

  type Attach = { url: string; name?: string; type?: string };
  const body = (await req.json().catch(() => ({}))) as { action?: string; body?: string; mentions?: string[]; attachments?: Attach[] };
  // Sanitize attachments to our own storage host only (never render an arbitrary URL).
  const cleanAttachments = (Array.isArray(body.attachments) ? body.attachments : [])
    .filter((a) => a && typeof a.url === "string" && /^https?:\/\//i.test(a.url))
    .slice(0, 10)
    .map((a) => ({ url: a.url, name: String(a.name || "image").slice(0, 200), type: String(a.type || "") }));
  switch (body.action) {
    case "comment":
    case "note": {
      const text = String(body.body || "").trim();
      if (!text && !cleanAttachments.length) return NextResponse.json({ error: "Empty comment" }, { status: 400 });
      const mentions = Array.isArray(body.mentions) ? body.mentions.filter(Boolean) : [];
      const meta: Record<string, unknown> = {};
      if (mentions.length) meta.mentions = mentions;
      if (cleanAttachments.length) meta.attachments = cleanAttachments;
      const act = await addActivity(deal.id, { user_email: me!.email, kind: body.action, body: text, meta: Object.keys(meta).length ? meta : null });
      if (mentions.length) await notifyMention(deal, mentions, me!.email, text || "(image)");
      return NextResponse.json({ ok: true, activity: act });
    }
    case "ingest": {
      const count = await ingestDealEmails(deal);
      const emails = await listDealEmails(deal.id);
      return NextResponse.json({ ok: true, ingested: count, emails });
    }
    case "resync-research": {
      // Re-pull the research findings and OVERWRITE the owner/appraisal sidebar fields.
      // The GET auto-fill only fills EMPTY fields (so a manual edit persists), so it won't
      // pick up a CHANGED likely owner after a report is re-run — this is the explicit
      // "force the new report into the deal" action. Report link is refreshed too.
      const patch: Record<string, unknown> = {};
      try { const link = await researchReportLink(deal.domain); if (link) patch.report_link = link; } catch { /* keep */ }
      const s = await researchReportSummary(deal.domain);
      if (s) {
        if (s.likely_owner) patch.likely_owner = s.likely_owner;
        if (s.owner_contact) patch.owner_contact = s.owner_contact;
        if (s.appraisal && s.appraisal.mid > 0) patch.appraisal_value = Math.round(s.appraisal.mid);
      }
      if (!Object.keys(patch).length) {
        return NextResponse.json({ ok: false, error: "No research findings yet for this domain." }, { status: 200 });
      }
      const updated = await updateDeal(deal.id, patch, me!.email);
      const act = await addActivity(deal.id, { user_email: me!.email, kind: "note", body: "Re-synced likely owner / contact / appraisal from the research report.", meta: { via: "resync" } });
      return NextResponse.json({ ok: true, deal: updated, activity: act });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
