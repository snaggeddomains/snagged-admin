// Buy-side deal creation — idempotent. Unique key = target domain + buyer email (per the
// scope doc), so the same buyer+domain never duplicates no matter which research surface
// the Add-to-Pipedrive button was clicked from; a DIFFERENT buyer for the same domain is a
// separate deal. Pipedrive is the system of record — we don't mirror anything into our DB.

import { resolvePipedrive, dealUrl } from "./pipedrive-fields";
import { searchPersonByEmail, createPerson, createOrganization, createDeal, searchDeals, getUsers } from "./pipedrive";

export type BuyDealInput = {
  domain: string;
  buyerEmail?: string;
  buyerName?: string;
  buyerPhone?: string;
  orgName?: string;
  source: string;                 // one of the Source/Channel enum labels
  additionalDomains?: string;
  budgetRange?: string;
  appraisalValue?: number;
  priority?: string;              // Priority enum label
  likelyOwner?: string;
  ownerContact?: string;
  auctionHandle?: string;
  reachability?: string;          // Reachability enum label
  reportLink?: string;
  askingPrice?: number;
  assigneeEmail?: string;         // OUR user's email; mapped to a Pipedrive owner if they exist there
};

export type BuyDealResult = { ok: boolean; dealId?: number; created?: boolean; url?: string; assigneePdUserId?: number; error?: string };

// Deterministic title = the idempotency handle. Human-readable, buyer-email stable.
function dealTitle(domain: string, buyerEmail?: string): string {
  return buyerEmail ? `${domain} — ${buyerEmail}` : domain;
}

// Map input → Pipedrive custom-field {key: value}. Enum values must be OPTION IDs; unknown
// fields/options are skipped (fail-open) so a create never breaks on a mapping gap.
function customFields(R: Awaited<ReturnType<typeof resolvePipedrive>>, input: BuyDealInput): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const set = (name: string, value: unknown) => { const k = R.fieldKey.get(name); if (k && value != null && value !== "") out[k] = value; };
  const setEnum = (name: string, label?: string) => { if (!label) return; const id = R.optionId.get(`${name}||${label}`); if (id != null) set(name, id); };
  set("Target Domain", input.domain);
  set("Additional Domains", input.additionalDomains);
  setEnum("Source / Channel", input.source);
  set("Client Name", input.buyerName);
  set("Client Contact", input.buyerEmail || input.buyerPhone);
  set("Budget Range", input.budgetRange);
  set("Appraisal Value", input.appraisalValue);
  setEnum("Priority", input.priority);
  set("Research Report Link", input.reportLink);
  set("Likely Owner", input.likelyOwner);
  set("Owner Contact", input.ownerContact);
  set("Asking / Target Price", input.askingPrice);
  set("Auction Handle", input.auctionHandle);
  setEnum("Reachability", input.reachability);
  return out;
}

export async function upsertBuyDeal(input: BuyDealInput): Promise<BuyDealResult> {
  const domain = String(input.domain || "").trim().toLowerCase();
  if (!domain) return { ok: false, error: "domain required" };
  const R = await resolvePipedrive();
  if (!R.pipelineId) return { ok: false, error: "Buy-Side pipeline not found — run /api/admin/pipedrive/setup?apply=1" };

  const title = dealTitle(domain, input.buyerEmail);

  // Idempotency: search deals by domain, match our exact title.
  try {
    const found = await searchDeals(domain);
    const hit = (found.data?.items || []).find((it) => it.item && it.item.title === title);
    if (hit) return { ok: true, dealId: hit.item.id, created: false, url: dealUrl(R, hit.item.id) };
  } catch { /* fall through to create */ }

  // Resolve the assignee → a Pipedrive owner (by email) + the right entry stage.
  let assigneePdUserId: number | undefined;
  if (input.assigneeEmail) {
    try {
      const users = await getUsers();
      assigneePdUserId = (users.data || []).find((u) => u.email?.toLowerCase() === input.assigneeEmail!.toLowerCase() && u.active_flag)?.id;
    } catch { /* leave unassigned */ }
  }
  const stageId = R.stageId.get(assigneePdUserId ? "Assigned" : "Unassigned / Inbox") || [...R.stageId.values()][0];

  // Person (find-or-create) + optional org.
  let personId: number | undefined;
  if (input.buyerEmail) {
    try {
      const s = await searchPersonByEmail(input.buyerEmail);
      personId = s.data?.items?.[0]?.item?.id;
    } catch { /* create below */ }
  }
  if (!personId && (input.buyerName || input.buyerEmail)) {
    const p = await createPerson({ name: input.buyerName || input.buyerEmail!, email: input.buyerEmail, phone: input.buyerPhone });
    if (p.ok && p.data) personId = p.data.id;
  }
  let orgId: number | undefined;
  if (input.orgName) { const o = await createOrganization(input.orgName); if (o.ok && o.data) orgId = o.data.id; }

  const body: Record<string, unknown> = {
    title,
    pipeline_id: R.pipelineId,
    stage_id: stageId,
    ...(personId ? { person_id: personId } : {}),
    ...(orgId ? { org_id: orgId } : {}),
    ...(assigneePdUserId ? { user_id: assigneePdUserId } : {}),
    ...customFields(R, input),
  };
  const deal = await createDeal(body);
  if (!deal.ok || !deal.data) return { ok: false, error: `create failed: ${deal.error}` };
  return { ok: true, dealId: deal.data.id, created: true, url: dealUrl(R, deal.data.id), assigneePdUserId };
}
