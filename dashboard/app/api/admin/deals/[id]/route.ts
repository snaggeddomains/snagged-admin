// One deal: detail (with activity + ingested emails), field/stage/owner/status updates,
// and actions (add a comment w/ @mentions, ingest emails, move on the board). Gated by
// the `deals` module; a non-deals.all user can only touch their own deals or the Inbox.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCan, userCanAction, type AppUser } from "@/lib/permissions";
import { getDeal, updateDeal, addActivity, listActivity, listDealEmails, setSamSplit, type Deal } from "@/lib/deals/store";
import { notifyAssignment, notifyStageChange, notifyMention, notifyComment, notifyShare } from "@/lib/deals/notify";
import { ingestDealEmails } from "@/lib/deals/emails";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";
import { researchReportLink, kickResearchRun, researchReportSummary } from "@/lib/deals/research-link";
import { isStage } from "@/lib/deals/stages";
import { assignableUsers } from "@/lib/deals/assignees";
import { getOwner } from "@/lib/deals/owners";
import { isSharedWith, listSharesForDeal, shareDeal, unshareDeal } from "@/lib/deals/sharing";
import { reminderForDeal, setReminder, clearReminder } from "@/lib/deals/reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 45;

// Base for the research app's inbound-lead dossier deep-link (#/lead/<key>).
const RESEARCH_APP_BASE = (process.env.RESEARCH_APP_BASE || "https://app.snagged.com/research").replace(/\/+$/, "");

// May this user EDIT this deal (fields / stage / reassign)? deals.all / admin → any; their
// own → yes; an unassigned Inbox deal → only if they hold deals.inbox (so they can claim it).
// A user the deal is merely SHARED with can view + comment, but not edit.
function mayEdit(me: AppUser, deal: Deal): boolean {
  if (me.is_admin || userCanAction(me, "deals.all")) return true;
  if (deal.owner_email) return deal.owner_email.toLowerCase() === me.email.toLowerCase();
  return userCanAction(me, "deals.inbox");
}

// May this user VIEW this deal? Editors, plus anyone it's been shared with.
async function mayView(me: AppUser, deal: Deal): Promise<boolean> {
  if (mayEdit(me, deal)) return true;
  return isSharedWith(deal.id, me.email);
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
  if (!(await mayView(me!, deal))) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });
  const canEdit = mayEdit(me!, deal);
  // Rule: if a Domain Owner report has been run for this exact domain, auto-link it.
  // Fill (once) when the deal has no report link yet + a run exists. If NO run exists
  // yet (e.g. a manually-added deal for a domain we've never researched), kick a FREE
  // pre-flight report so the link auto-fills on a later view — no button, no waiting.
  if (!deal.report_link) {
    const link = await researchReportLink(deal.domain);
    if (link) { try { deal = await updateDeal(deal.id, { report_link: link }, null); } catch { /* keep unlinked */ } }
    else { await kickResearchRun(deal.domain); }
  }
  // Auto-sync the sidebar from research: on each view, refresh likely owner / owner contact /
  // appraisal to the report's CURRENT findings — so a re-run report (owner changed) flows through
  // on its own. A field the user has MANUALLY edited (tracked in owner_manual) is frozen and never
  // overwritten; everything else tracks research. Only writes when a value actually changed.
  if (deal.report_link) {
    const s = await researchReportSummary(deal.domain);
    if (s) {
      const manual = (deal.owner_manual || {}) as Record<string, boolean>;
      const patch: Record<string, unknown> = {};
      if (!manual.likely_owner && s.likely_owner && deal.likely_owner !== s.likely_owner) patch.likely_owner = s.likely_owner;
      if (!manual.owner_contact && s.owner_contact && deal.owner_contact !== s.owner_contact) patch.owner_contact = s.owner_contact;
      if (!manual.appraisal_value && s.appraisal && s.appraisal.mid > 0) {
        const mid = Math.round(s.appraisal.mid);
        if (deal.appraisal_value !== mid) patch.appraisal_value = mid;
      }
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
  const [activity, emails, assignees, shares, reminder] = await Promise.all([
    listActivity(deal.id), listDealEmails(deal.id), assignableUsers(),
    listSharesForDeal(deal.id), reminderForDeal(deal.id, me!.email),
  ]);
  // The confirmed owner record (built at Negotiating), for the sidebar link + directory.
  let ownerRecord: { id: string; name: string } | null = null;
  if (deal.domain_owner_id) { try { const o = await getOwner(deal.domain_owner_id); if (o) ownerRecord = { id: o.id, name: o.name }; } catch { /* best-effort */ } }
  const canSamSplit = me!.is_admin || userCanAction(me!, "deals.sam_split");
  return NextResponse.json({ ok: true, deal, dossierUrl, additional, ownerRecord, activity, emails, assignees, shares, reminder, canEdit, canSamSplit, me: me!.email });
}

const EDITABLE = new Set([
  "domain", "additional_domains", "buyer_name", "buyer_email", "buyer_phone", "org_name",
  "budget_range", "appraisal_value", "asking_price", "current_offer", "sale_price", "commission", "upfront_fee", "upfront_paid", "source", "heard_about", "priority", "owner_email",
  "stage", "status", "lost_reason", "report_link", "likely_owner", "owner_contact",
  "reachability", "notes", "tags", "position",
]);

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { me, err } = await gate(req);
  if (err) return err;
  const deal = await getDeal(params.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!mayEdit(me!, deal)) return NextResponse.json({ error: "You can view this shared deal but not edit it." }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (EDITABLE.has(k)) patch[k] = v;
  // A research-derived field (likely owner / owner contact / appraisal) the user ACTUALLY
  // changes gets frozen — it stops auto-syncing from the report. Compare to the current value
  // so an unchanged field submitted by the edit form doesn't accidentally freeze it.
  {
    const manual = { ...((deal.owner_manual || {}) as Record<string, boolean>) };
    let touched = false;
    for (const fld of ["likely_owner", "owner_contact", "appraisal_value"] as const) {
      if (fld in patch && String(patch[fld] ?? "") !== String((deal as Record<string, unknown>)[fld] ?? "")) {
        manual[fld] = true; touched = true;
      }
    }
    if (touched) patch.owner_manual = manual;
  }
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
      patch.owner_manual = null;   // new domain → fields auto-sync fresh from its report
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
  // View access lets a shared collaborator comment / snooze / share on; edit-actions
  // (ingest, resync) are gated to editors below.
  if (!(await mayView(me!, deal))) return NextResponse.json({ error: "No access to this deal" }, { status: 403 });
  const canEdit = mayEdit(me!, deal);

  type Attach = { url: string; name?: string; type?: string };
  const body = (await req.json().catch(() => ({}))) as { action?: string; body?: string; mentions?: string[]; attachments?: Attach[]; emails?: string[]; email?: string; remind_at?: string; note?: string; value?: boolean };
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
      const mentionSet = new Set(mentions.map((e) => e.toLowerCase()));
      if (mentions.length) {
        // @mentioning someone SHARES the deal with them (view + comment access), then notifies.
        const targets = mentions.filter((e) => e.toLowerCase() !== String(deal.owner_email || "").toLowerCase());
        await shareDeal(deal.id, targets, me!.email);
        await notifyMention(deal, mentions, me!.email, text || "(image)");
      }
      // Keep every PARTICIPANT in the loop on this comment (both directions): owner + everyone
      // shared/tagged on the deal + anyone who's commented before. Exclude the author and anyone
      // @mentioned in THIS comment (they already got the "mentioned you" notification). Best-effort.
      try {
        const [shares, activity] = await Promise.all([listSharesForDeal(deal.id), listActivity(deal.id)]);
        const participants = new Set<string>();
        if (deal.owner_email) participants.add(deal.owner_email.toLowerCase());
        for (const s of shares) participants.add(s.toLowerCase());
        for (const a of activity) if ((a.kind === "comment" || a.kind === "note") && a.user_email) participants.add(a.user_email.toLowerCase());
        const recipients = [...participants].filter((e) => e !== me!.email.toLowerCase() && !mentionSet.has(e));
        if (recipients.length) await notifyComment(deal, recipients, me!.email, text || "(image)");
      } catch { /* notifications are best-effort — never fail the comment */ }
      return NextResponse.json({ ok: true, activity: act });
    }
    case "share": {
      const emails = Array.isArray(body.emails) ? body.emails.filter(Boolean) : [];
      if (!emails.length) return NextResponse.json({ error: "No one to share with" }, { status: 400 });
      const added = await shareDeal(deal.id, emails, me!.email);
      if (added.length) await notifyShare(deal, added, me!.email);
      return NextResponse.json({ ok: true, added, shares: await listSharesForDeal(deal.id) });
    }
    case "unshare": {
      const email = String(body.email || "").trim();
      if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
      await unshareDeal(deal.id, email);
      return NextResponse.json({ ok: true, shares: await listSharesForDeal(deal.id) });
    }
    case "snooze": {
      // Boomerang: set MY personal reminder to revisit this deal on a date.
      const remindAt = String(body.remind_at || "").trim();
      if (!remindAt || Number.isNaN(Date.parse(remindAt))) return NextResponse.json({ error: "remind_at (date) required" }, { status: 400 });
      const reminder = await setReminder(deal.id, me!.email, new Date(remindAt).toISOString(), String(body.note || "") || null, me!.email);
      return NextResponse.json({ ok: true, reminder });
    }
    case "unsnooze": {
      await clearReminder(deal.id, me!.email);
      return NextResponse.json({ ok: true, reminder: null });
    }
    case "sam_split": {
      // Permission-gated (deals.sam_split: Rob/Judy/Brian) — independent of edit rights on the deal.
      if (!me!.is_admin && !userCanAction(me!, "deals.sam_split")) return NextResponse.json({ error: "Not allowed to toggle this." }, { status: 403 });
      const updated = await setSamSplit(deal.id, !!body.value, me!.email);
      return NextResponse.json({ ok: true, deal: updated });
    }
    case "ingest": {
      if (!canEdit) return NextResponse.json({ error: "You can view this shared deal but not edit it." }, { status: 403 });
      // Human-initiated pull → if we're at the Gmail throttle line, fail loudly with a clear message.
      try {
        const count = await withGmailFeature("deal-emails", () => ingestDealEmails(deal));
        const emails = await listDealEmails(deal.id);
        return NextResponse.json({ ok: true, ingested: count, emails });
      } catch (e) {
        if (isGmailBudgetError(e)) return NextResponse.json({ ok: false, budgetPaused: true, error: GMAIL_BUDGET_MESSAGE }, { status: 429 });
        throw e;
      }
    }
    case "resync-research": {
      if (!canEdit) return NextResponse.json({ error: "You can view this shared deal but not edit it." }, { status: 403 });
      // Re-pull the research findings and OVERWRITE the owner/appraisal sidebar fields.
      // The GET auto-fill only fills EMPTY fields (so a manual edit persists), so it won't
      // pick up a CHANGED likely owner after a report is re-run — this is the explicit
      // "force the new report into the deal" action. Report link is refreshed too.
      const patch: Record<string, unknown> = { owner_manual: null };   // un-freeze → resume auto-sync
      try { const link = await researchReportLink(deal.domain); if (link) patch.report_link = link; } catch { /* keep */ }
      const s = await researchReportSummary(deal.domain);
      let gotFindings = false;
      if (s) {
        if (s.likely_owner) { patch.likely_owner = s.likely_owner; gotFindings = true; }
        if (s.owner_contact) { patch.owner_contact = s.owner_contact; gotFindings = true; }
        if (s.appraisal && s.appraisal.mid > 0) { patch.appraisal_value = Math.round(s.appraisal.mid); gotFindings = true; }
      }
      if (!gotFindings && !patch.report_link) {
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
