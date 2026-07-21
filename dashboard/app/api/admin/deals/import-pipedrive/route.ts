// One-time importer: pulls every deal from the Pipedrive "Buy-Side Deal Flow" pipeline
// and creates the matching native deal. GET previews (dry-run); GET ?apply=1 imports.
// Admin-only. Idempotent (createDeal dedupes by domain+buyer), so it's safe to re-run.
// Reuses the (otherwise dormant) Pipedrive client one last time for the migration.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { getPipelines, getStages, getDealFields, getUsers, getDeals, type PdDeal } from "@/lib/pipedrive";
import { createDeal, updateDeal, type CreateDealInput } from "@/lib/deals/store";
import { BUY_PIPELINE } from "@/lib/pipedrive-setup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin && !userCanAction(me, "deals.all")) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  const apply = new URL(req.url).searchParams.get("apply") === "1";

  const [pipelines, fields, users] = await Promise.all([getPipelines(), getDealFields(), getUsers()]);
  if (!pipelines.ok) return NextResponse.json({ error: `Can't read Pipedrive: ${pipelines.error}` }, { status: 502 });
  const pipelineId = (pipelines.data || []).find((p) => p.name === BUY_PIPELINE)?.id;
  if (!pipelineId) return NextResponse.json({ error: `Pipeline "${BUY_PIPELINE}" not found` }, { status: 404 });

  // name → key, name → type, `${name}||${optionId}` → enum label.
  const keyByName = new Map<string, string>();
  const typeByName = new Map<string, string>();
  const optionLabel = new Map<string, string>();
  for (const f of fields.data || []) {
    keyByName.set(f.name, f.key);
    typeByName.set(f.name, f.field_type);
    for (const o of f.options || []) optionLabel.set(`${f.name}||${o.id}`, o.label);
  }
  const cf = (deal: PdDeal, name: string): string | undefined => {
    const k = keyByName.get(name);
    if (!k) return undefined;
    const v = deal[k];
    if (v == null || v === "") return undefined;
    if (typeByName.get(name) === "enum") return optionLabel.get(`${name}||${v}`) ?? undefined;
    return String(v);
  };

  const stages = await getStages(pipelineId);
  const stageName = new Map<number, string>();
  for (const s of stages.data || []) stageName.set(s.id, s.name);
  const userEmail = new Map<number, string>();
  for (const u of users.data || []) userEmail.set(u.id, u.email);

  const deals = await getDeals(pipelineId);
  if (!deals.ok) return NextResponse.json({ error: `Can't read deals: ${deals.error}` }, { status: 502 });

  const num = (v: string | undefined): number | undefined => { if (v == null) return undefined; const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? n : undefined; };
  const isEmail = (s?: string) => !!s && /@/.test(s);

  const preview: { domain: string; buyer: string; stage: string; status: string; owner: string; imported?: boolean; skipped?: boolean; error?: string }[] = [];

  for (const d of deals.data || []) {
    // Title convention was `${domain} — ${buyerEmail}`.
    const [titleDomain, titleBuyer] = String(d.title || "").split(" — ").map((s) => s.trim());
    const domain = (cf(d, "Target Domain") || titleDomain || "").toLowerCase();
    if (!domain || !domain.includes(".")) continue;
    const clientContact = cf(d, "Client Contact");
    const buyerEmail = isEmail(clientContact) ? clientContact : (isEmail(titleBuyer) ? titleBuyer : undefined);
    const uid = d.user_id && typeof d.user_id === "object" ? d.user_id.id : (typeof d.user_id === "number" ? d.user_id : undefined);
    const ownerEmail = (d.user_id && typeof d.user_id === "object" && d.user_id.email) || (uid ? userEmail.get(uid) : undefined);
    const stage = stageName.get(d.stage_id) || "Unassigned / Inbox";
    const status = ["open", "won", "lost"].includes(d.status) ? d.status : "open";

    const input: CreateDealInput = {
      domain,
      buyerName: cf(d, "Client Name") || d.person_name || undefined,
      buyerEmail,
      orgName: d.org_name || undefined,
      ownerEmail,
      source: cf(d, "Source / Channel"),
      priority: cf(d, "Priority"),
      budgetRange: cf(d, "Budget Range"),
      appraisalValue: num(cf(d, "Appraisal Value")),
      askingPrice: num(cf(d, "Asking / Target Price")),
      reportLink: cf(d, "Research Report Link"),
      likelyOwner: cf(d, "Likely Owner"),
      ownerContact: cf(d, "Owner Contact"),
      reachability: cf(d, "Reachability"),
      additionalDomains: cf(d, "Additional Domains"),
      createdBy: me.email,
    };
    const row = { domain, buyer: buyerEmail || input.buyerName || "—", stage, status, owner: ownerEmail || "Inbox" };

    if (!apply) { preview.push(row); continue; }
    try {
      const { deal, created } = await createDeal(input);
      // Preserve the Pipedrive stage/status (createDeal enters at Assigned/Inbox + open).
      if (created && (deal.stage !== stage || deal.status !== status)) {
        await updateDeal(deal.id, { stage, status }, me.email);
      }
      preview.push({ ...row, imported: created, skipped: !created });
    } catch (e) {
      preview.push({ ...row, error: String((e as Error)?.message || e) });
    }
  }

  const imported = preview.filter((p) => p.imported).length;
  const skipped = preview.filter((p) => p.skipped).length;
  return NextResponse.json({
    ok: true, pipeline: BUY_PIPELINE, dryRun: !apply,
    totalPipedriveDeals: (deals.data || []).length,
    imported, skipped, rows: preview,
    hint: apply ? undefined : "Add ?apply=1 to actually import.",
  });
}
