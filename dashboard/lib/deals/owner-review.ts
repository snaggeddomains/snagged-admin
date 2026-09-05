// Owner Review queue — human-in-the-loop confirmation of the "owner we bought from" for each
// closed Master Txn where our email search surfaced a candidate. Reviewers (Rob / Brian / Sam)
// are prompted in Admin/Deals to confirm; on Confirm the owner is upserted into deal_owners AND
// linked to every deal for that domain. New Master Txn rows create a new pending card (Increment 2).
//
// Data: owner_review_cards (main project — scripts/owner_review.sql). Fail-soft: a missing table
// (migration not run) returns [] / 0 rather than erroring, so Admin/Deals stay usable pre-migration.

import { getDb, isDbConfigured } from "../supabase";
import { findOwner, getOwner, createOwner, updateOwner, type OwnerInput } from "./owners";

const CARDS = "owner_review_cards";
const DEALS = "deals";

export type OwnerReviewStatus = "pending" | "confirmed" | "rejected" | "skipped" | "dismissed";

export type OwnerReviewCard = {
  id: string;
  domain: string;
  txn_date: string | null;
  txn_price: string | null;
  candidate_name: string | null;         // computed display = "First Last" (kept for search/back-compat)
  candidate_first_name: string | null;
  candidate_last_name: string | null;
  candidate_email: string | null;
  candidate_phone: string | null;
  candidate_company: string | null;      // owning entity (e.g. "Blue Nova") when the contact is its rep
  channel: string | null;
  buyer_context: string | null;
  confidence: string | null;
  evidence: string | null;
  notes: string | null;
  status: OwnerReviewStatus;
  assigned_to: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  deal_owner_id: string | null;
  source: string;
  created_at: string;
  updated_at: string;
};

export function ownerReviewConfigured(): boolean {
  return isDbConfigured();
}

function missingTable(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  const code = e?.code || "";
  const msg = (e?.message || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table");
}

const clean = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s || null; };
const lc = (s: string) => s.toLowerCase();

// List cards for the queue. Defaults to pending; `assigned_to` narrows to one reviewer's cards
// (the banner + "mine" view). `q` filters by domain/candidate. Newest txn first.
export async function listCards(opts: { assigned_to?: string; include_unassigned?: boolean; status?: OwnerReviewStatus | "all"; q?: string; limit?: number } = {}): Promise<OwnerReviewCard[]> {
  if (!isDbConfigured()) return [];
  let query = getDb().from(CARDS).select("*");
  const status = opts.status || "pending";
  if (status !== "all") query = query.eq("status", status);
  if (opts.assigned_to) {
    // "Assigned to me" also surfaces UNCLAIMED cards (cron-mined ones land unassigned), so the
    // default view is "mine + the shared backlog" rather than hiding freshly-mined cards.
    query = opts.include_unassigned
      ? query.or(`assigned_to.eq.${lc(opts.assigned_to)},assigned_to.is.null`)
      : query.eq("assigned_to", lc(opts.assigned_to));
  }
  if (opts.q && opts.q.trim()) { const like = `%${opts.q.trim()}%`; query = query.or(`domain.ilike.${like},candidate_name.ilike.${like},candidate_email.ilike.${like}`); }
  query = query.order("created_at", { ascending: false }).limit(Math.min(opts.limit ?? 500, 1000));
  const { data, error } = await query;
  if (error) { if (missingTable(error)) return []; throw new Error(`listCards: ${error.message}`); }
  return (data as OwnerReviewCard[]) || [];
}

// Count of PENDING cards assigned to a reviewer — powers the per-user Admin banner. Fail-soft 0.
export async function countPending(email: string): Promise<number> {
  if (!isDbConfigured() || !email) return 0;
  try {
    const { count, error } = await getDb().from(CARDS).select("id", { count: "exact", head: true })
      .eq("status", "pending").eq("assigned_to", lc(email));
    if (error) { if (missingTable(error)) return 0; throw error; }
    return count || 0;
  } catch { return 0; }
}

// Live count of pending cards NOT yet re-mined this sweep (remined_at null) — the true "left to
// re-mine" for the auto-drain badge, vs the cron's stale self-reported number. Strip-and-retry the
// remined_at predicate so it degrades to "all pending" pre-migration.
export async function countUnmined(): Promise<number> {
  if (!isDbConfigured()) return 0;
  try {
    const { count, error } = await getDb().from(CARDS).select("id", { count: "exact", head: true })
      .eq("status", "pending").is("remined_at", null);
    if (error) {
      if (missingTable(error)) return 0;
      if (/remined_at/.test(error.message || "")) {
        const { count: c2 } = await getDb().from(CARDS).select("id", { count: "exact", head: true }).eq("status", "pending");
        return c2 || 0;
      }
      throw error;
    }
    return count || 0;
  } catch { return 0; }
}

export async function getCard(id: string): Promise<OwnerReviewCard | null> {
  if (!isDbConfigured()) return null;
  const { data, error } = await getDb().from(CARDS).select("*").eq("id", id).maybeSingle();
  if (error) { if (missingTable(error)) return null; throw new Error(`getCard: ${error.message}`); }
  return (data as OwnerReviewCard) || null;
}

// Patch the editable candidate fields (used before confirming — reviewer corrects name/email/etc).
const EDITABLE = new Set(["candidate_name", "candidate_first_name", "candidate_last_name", "candidate_email", "candidate_phone", "candidate_company", "channel", "buyer_context", "confidence", "evidence", "notes", "assigned_to"]);

// Resolve first/last for a card — prefer the explicit first/last fields, else split the full
// candidate_name (first token = first, remainder = last). Returns clean pieces + the joined name.
function nameParts(c: { candidate_first_name?: string | null; candidate_last_name?: string | null; candidate_name?: string | null }): { first: string; last: string; full: string } {
  let first = clean(c.candidate_first_name) || "";
  let last = clean(c.candidate_last_name) || "";
  if (!first && !last) {
    const toks = (clean(c.candidate_name) || "").split(/\s+/).filter(Boolean);
    first = toks[0] || "";
    last = toks.slice(1).join(" ");
  }
  return { first, last, full: [first, last].filter(Boolean).join(" ") };
}
export async function updateCard(id: string, patch: Record<string, unknown>, by: string | null): Promise<OwnerReviewCard> {
  const current = await getCard(id);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.has(k)) continue;
    update[k] = k === "assigned_to" ? (clean(v) ? lc(String(v)) : null) : clean(v);
  }
  // Keep candidate_name (the display/owner name) in sync with edited first/last.
  if (("candidate_first_name" in update || "candidate_last_name" in update) && current) {
    const merged = { ...current, ...update } as OwnerReviewCard;
    const { full } = nameParts({ candidate_first_name: merged.candidate_first_name, candidate_last_name: merged.candidate_last_name, candidate_name: null });
    if (full) update.candidate_name = full;
  }
  let { data, error } = await getDb().from(CARDS).update(update).eq("id", id).select("*").single();
  if (error && /candidate_company/.test(error.message || "")) {   // pre-migration → drop the new column + retry
    delete (update as Record<string, unknown>).candidate_company;
    ({ data, error } = await getDb().from(CARDS).update(update).eq("id", id).select("*").single());
  }
  if (error) throw new Error(`updateCard: ${error.message}`);
  void by;
  return data as OwnerReviewCard;
}

// Terminal status without a confirm — reject (not a real seller / can't determine), skip (decide
// later), or dismiss (not worth logging an owner — set aside). All are reopenable.
export async function setCardStatus(id: string, status: "rejected" | "skipped" | "dismissed" | "pending", by: string | null): Promise<OwnerReviewCard> {
  const update: Record<string, unknown> = {
    status,
    updated_at: new Date().toISOString(),
    reviewed_by: status === "pending" ? null : clean(by),
    reviewed_at: status === "pending" ? null : new Date().toISOString(),
  };
  const { data, error } = await getDb().from(CARDS).update(update).eq("id", id).select("*").single();
  if (error) throw new Error(`setCardStatus: ${error.message}`);
  return data as OwnerReviewCard;
}

// Reassign a card to a different reviewer (per-card assignment).
export async function reassignCard(id: string, assignedTo: string | null): Promise<OwnerReviewCard> {
  const { data, error } = await getDb().from(CARDS)
    .update({ assigned_to: assignedTo ? lc(assignedTo) : null, updated_at: new Date().toISOString() })
    .eq("id", id).select("*").single();
  if (error) throw new Error(`reassignCard: ${error.message}`);
  return data as OwnerReviewCard;
}

// CONFIRM — the payoff. Apply the (optionally reviewer-edited) candidate:
//   1. upsert into deal_owners (find-or-create by shared email / exact name; merge contacts +
//      append a provenance negotiation note),
//   2. link EVERY deal for this domain to that owner (a domain → its owner),
//   3. mark the card confirmed + stamp deal_owner_id.
// Idempotent — re-confirming just re-upserts + re-links.
export async function confirmCard(id: string, patch: Record<string, unknown>, by: string | null, linkOwnerId?: string | null): Promise<{ card: OwnerReviewCard; owner_id: string; linked: number }> {
  const card = await getCard(id);
  if (!card) throw new Error("card not found");
  // Apply any inline edits first so the confirmed values persist on the card + flow to the owner.
  const merged = { ...card, ...Object.fromEntries(Object.entries(patch).filter(([k]) => EDITABLE.has(k))) } as OwnerReviewCard;

  const { first, last, full } = nameParts(merged);
  const name = full || clean(merged.candidate_name);   // "First Last"
  const email = clean(merged.candidate_email);
  if (!name && !email) throw new Error("a candidate name or email is required to confirm an owner");

  const emails = email ? [email] : [];
  const phones = clean(merged.candidate_phone) ? [String(merged.candidate_phone).trim()] : [];
  const company = clean(merged.candidate_company);
  const provenance = `Confirmed as the owner we bought ${merged.domain} from${merged.txn_date ? ` (${merged.txn_date}${merged.txn_price ? `, ${merged.txn_price}` : ""})` : ""}${merged.channel ? ` via ${merged.channel}` : ""}${company ? ` — entity: ${company}` : ""}.`;

  // 1. Upsert the owner. `company` = the owning entity (e.g. Blue Nova) when the contact is its rep.
  // linkOwnerId (the "🔗 Link to an existing owner" typeahead) forces linking to THAT owner record so
  // the card GROUPS with it — merging this card's contact into it — instead of a fuzzy name/email match.
  let owner = linkOwnerId ? await getOwner(linkOwnerId) : await findOwner({ name: name || undefined, emails });
  if (owner) {
    owner = await updateOwner(owner.id, {
      ...(name ? { name } : {}),
      ...(company ? { company } : {}),   // only set/overwrite when we actually mined one
      emails_add: emails, phones_add: phones,
      negotiation_append: provenance,
    }, by);
  } else {
    const input: OwnerInput = {
      name: name || email || merged.domain,
      kind: company ? "company" : "person",
      company: company || null,
      emails, phones,
      negotiation_notes: provenance,
    };
    owner = await createOwner(input, by);
  }

  // 2. Link every deal for this domain (lowercased == stored form) to the owner.
  let linked = 0;
  try {
    const { data: deals } = await getDb().from(DEALS).select("id").eq("domain", lc(merged.domain));
    const ids = ((deals as { id: string }[]) || []).map((d) => d.id);
    if (ids.length) {
      const { error } = await getDb().from(DEALS).update({ domain_owner_id: owner.id, updated_at: new Date().toISOString() }).in("id", ids);
      if (!error) linked = ids.length;
    }
  } catch { /* linking is best-effort — the owner record is the primary outcome */ }

  // 3. Persist the confirmed edits + mark the card done.
  const update: Record<string, unknown> = {
    candidate_name: name || clean(merged.candidate_name),
    candidate_first_name: first || null,
    candidate_last_name: last || null,
    candidate_email: email,
    candidate_phone: clean(merged.candidate_phone),
    candidate_company: company,
    channel: clean(merged.channel),
    buyer_context: clean(merged.buyer_context),
    confidence: clean(merged.confidence),
    evidence: clean(merged.evidence),
    notes: clean(merged.notes),
    status: "confirmed",
    reviewed_by: clean(by),
    reviewed_at: new Date().toISOString(),
    deal_owner_id: owner.id,
    updated_at: new Date().toISOString(),
  };
  let { data, error } = await getDb().from(CARDS).update(update).eq("id", id).select("*").single();
  if (error && /candidate_company/.test(error.message || "")) {   // pre-migration → drop the new column + retry
    delete (update as Record<string, unknown>).candidate_company;
    ({ data, error } = await getDb().from(CARDS).update(update).eq("id", id).select("*").single());
  }
  if (error) throw new Error(`confirmCard: ${error.message}`);
  return { card: data as OwnerReviewCard, owner_id: owner.id, linked };
}

// Find-or-create a card for a domain (Increment 2: new Master Txn row → new pending card).
// Idempotent by lower(domain) (the unique index). Returns null pre-migration.
export async function upsertCardForDomain(input: Partial<OwnerReviewCard> & { domain: string }, assignedTo?: string | null): Promise<OwnerReviewCard | null> {
  if (!isDbConfigured()) return null;
  const domain = lc(String(input.domain || "").trim());
  if (!domain) return null;
  try {
    const existing = await getDb().from(CARDS).select("*").eq("domain", domain).maybeSingle();
    if (existing.data) return existing.data as OwnerReviewCard;
    const row = {
      domain,
      txn_date: clean(input.txn_date), txn_price: clean(input.txn_price),
      candidate_name: clean(input.candidate_name), candidate_first_name: clean(input.candidate_first_name), candidate_last_name: clean(input.candidate_last_name),
      candidate_email: clean(input.candidate_email), candidate_phone: clean(input.candidate_phone),
      channel: clean(input.channel), buyer_context: clean(input.buyer_context),
      confidence: clean(input.confidence), evidence: clean(input.evidence),
      status: "pending", assigned_to: assignedTo ? lc(assignedTo) : null, source: input.source || "txn",
    };
    const { data, error } = await getDb().from(CARDS).insert(row).select("*").single();
    if (error) { if (missingTable(error)) return null; throw error; }
    return data as OwnerReviewCard;
  } catch (e) { if (missingTable(e)) return null; throw e; }
}
