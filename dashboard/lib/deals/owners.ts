// Owner intelligence directory — the persistent record of every domain owner we work with:
// contact info, a general dossier, and how they've negotiated over time. Built up over
// deals: seeded from a deal's researched "likely owner" and confirmed at the Negotiating
// stage (when we're confident they truly own the name). One owner ↔ many deals via
// deals.domain_owner_id, so an owner's detail aggregates every name/deal we've worked with them.

import { getDb, isDbConfigured } from "../supabase";

const OWNERS = "deal_owners";
const DEALS = "deals";

export type DealOwner = {
  id: string;
  name: string;
  kind: string;                      // person | company | unknown
  company: string | null;
  emails: string[];
  phones: string[];
  links: string[];
  reachability: string | null;
  notes: string | null;
  negotiation_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

// A deal as it appears on an owner's detail — the names/deals we've worked with them.
export type OwnerDeal = {
  id: string; domain: string; stage: string; status: string;
  buyer_name: string | null; asking_price: number | null; sale_price: number | null;
  created_at: string; updated_at: string;
};

export type OwnerInput = {
  name: string;
  kind?: string;
  company?: string | null;
  emails?: string[];
  phones?: string[];
  links?: string[];
  reachability?: string | null;
  notes?: string | null;
  negotiation_notes?: string | null;
};

export function ownersConfigured(): boolean {
  return isDbConfigured();
}

const clean = (v: unknown): string | null => { const s = String(v ?? "").trim(); return s || null; };
const cleanArr = (a?: unknown): string[] =>
  Array.isArray(a) ? [...new Set(a.map((x) => String(x ?? "").trim()).filter(Boolean))]
  : (typeof a === "string" && a.trim() ? a.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean) : []);
const lc = (s: string) => s.toLowerCase();
// Emails stored lowercased so owner dedup (overlap match) is reliable.
const emailArr = (a?: unknown): string[] => [...new Set(cleanArr(a).map(lc))];

// List owners (optionally filtered by name/company/email), newest-updated first, each with
// a count of the deals linked to it. Bounded for safety.
export async function listOwners(opts: { q?: string; limit?: number } = {}): Promise<(DealOwner & { deal_count: number })[]> {
  let query = getDb().from(OWNERS).select("*").order("updated_at", { ascending: false }).limit(Math.min(opts.limit ?? 500, 1000));
  if (opts.q && opts.q.trim()) {
    const like = `%${opts.q.trim()}%`;
    // name / company ilike, OR an email/link array element containing the term (cs on text[]
    // needs an exact element, so we ilike name/company and post-filter emails in JS below).
    query = query.or(`name.ilike.${like},company.ilike.${like}`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`listOwners: ${error.message}`);
  let owners = (data as DealOwner[]) || [];
  // If a search term didn't hit name/company, also try matching an email locally over a
  // broader pull, so "gmail.com" or a partial address still finds the owner.
  if (opts.q && opts.q.trim() && owners.length === 0) {
    const all = await getDb().from(OWNERS).select("*").order("updated_at", { ascending: false }).limit(1000);
    const term = lc(opts.q.trim());
    owners = ((all.data as DealOwner[]) || []).filter((o) =>
      (o.emails || []).some((e) => lc(e).includes(term)) || (o.phones || []).some((p) => p.includes(term)));
  }
  if (!owners.length) return [];
  // Deal counts per owner (one grouped read).
  const ids = owners.map((o) => o.id);
  const counts: Record<string, number> = {};
  try {
    const { data: dd } = await getDb().from(DEALS).select("domain_owner_id").in("domain_owner_id", ids);
    for (const r of (dd as { domain_owner_id: string | null }[]) || []) if (r.domain_owner_id) counts[r.domain_owner_id] = (counts[r.domain_owner_id] || 0) + 1;
  } catch { /* count is best-effort */ }
  return owners.map((o) => ({ ...o, deal_count: counts[o.id] || 0 }));
}

export async function getOwner(id: string): Promise<DealOwner | null> {
  const { data, error } = await getDb().from(OWNERS).select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`getOwner: ${error.message}`);
  return (data as DealOwner) || null;
}

// Every deal linked to this owner — the names we've worked with them.
export async function ownerDeals(id: string): Promise<OwnerDeal[]> {
  const { data, error } = await getDb().from(DEALS)
    .select("id,domain,stage,status,buyer_name,asking_price,sale_price,created_at,updated_at")
    .eq("domain_owner_id", id).order("updated_at", { ascending: false });
  if (error) return [];
  return (data as OwnerDeal[]) || [];
}

// Find an existing owner by any shared email (strongest), else by exact (case-insensitive)
// name. Returns null if nothing matches — the caller then creates.
export async function findOwner(input: { name?: string | null; emails?: string[] }): Promise<DealOwner | null> {
  const emails = cleanArr(input.emails).map(lc);
  if (emails.length) {
    // Overlap on the emails array (any shared address = same person).
    const { data } = await getDb().from(OWNERS).select("*").overlaps("emails", emails).limit(1);
    if (data && data.length) return data[0] as DealOwner;
  }
  const name = clean(input.name);
  if (name) {
    const { data } = await getDb().from(OWNERS).select("*").ilike("name", name).limit(1);
    if (data && data.length) return data[0] as DealOwner;
  }
  return null;
}

// Create a new owner. Arrays deduped; kind normalized.
export async function createOwner(input: OwnerInput, by: string | null): Promise<DealOwner> {
  const name = clean(input.name);
  if (!name) throw new Error("owner name required");
  const row = {
    name,
    kind: ["person", "company"].includes(String(input.kind)) ? input.kind : "unknown",
    company: clean(input.company),
    emails: emailArr(input.emails),
    phones: cleanArr(input.phones),
    links: cleanArr(input.links),
    reachability: clean(input.reachability),
    notes: clean(input.notes),
    negotiation_notes: clean(input.negotiation_notes),
    created_by: clean(by),
  };
  const { data, error } = await getDb().from(OWNERS).insert(row).select("*").single();
  if (error) throw new Error(`createOwner: ${error.message}`);
  return data as DealOwner;
}

// Patch an owner. Array fields (emails/phones/links) MERGE (union) rather than replace when
// passed as `*_add`; passing emails/phones/links directly REPLACES. Negotiation notes can be
// APPENDED via negotiation_append (timestamped-ish, one line) so history accrues.
export async function updateOwner(id: string, patch: Record<string, unknown>, by: string | null): Promise<DealOwner> {
  const before = await getOwner(id);
  if (!before) throw new Error("owner not found");
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("name" in patch) { const n = clean(patch.name); if (n) update.name = n; }
  if ("kind" in patch) update.kind = ["person", "company"].includes(String(patch.kind)) ? patch.kind : "unknown";
  if ("company" in patch) update.company = clean(patch.company);
  if ("reachability" in patch) update.reachability = clean(patch.reachability);
  if ("notes" in patch) update.notes = clean(patch.notes);
  if ("negotiation_notes" in patch) update.negotiation_notes = clean(patch.negotiation_notes);
  for (const key of ["emails", "phones", "links"] as const) {
    const norm = key === "emails" ? emailArr : cleanArr;
    if (key in patch) update[key] = norm(patch[key]);
    if (`${key}_add` in patch) update[key] = [...new Set([...(before[key] || []), ...norm(patch[`${key}_add`])])];
  }
  if ("negotiation_append" in patch) {
    const add = clean(patch.negotiation_append);
    if (add) {
      const stamp = new Date().toISOString().slice(0, 10);
      const line = `[${stamp}${by ? ` · ${by.split("@")[0]}` : ""}] ${add}`;
      update.negotiation_notes = before.negotiation_notes ? `${before.negotiation_notes}\n${line}` : line;
    }
  }
  const { data, error } = await getDb().from(OWNERS).update(update).eq("id", id).select("*").single();
  if (error) throw new Error(`updateOwner: ${error.message}`);
  return data as DealOwner;
}

// Delete an owner. Linked deals' domain_owner_id is nulled by the FK (on delete set null),
// so the deals themselves are untouched — they just lose the owner link.
export async function deleteOwner(id: string): Promise<void> {
  const { error } = await getDb().from(OWNERS).delete().eq("id", id);
  if (error) throw new Error(`deleteOwner: ${error.message}`);
}

// Link (or unlink) a deal to an owner.
export async function linkDealOwner(dealId: string, ownerId: string | null): Promise<void> {
  const { error } = await getDb().from(DEALS).update({ domain_owner_id: ownerId, updated_at: new Date().toISOString() }).eq("id", dealId);
  if (error) throw new Error(`linkDealOwner: ${error.message}`);
}

// Confirm-the-owner flow (fired at Negotiating): find-or-create the owner from the confirmed
// details, link the deal to it, merge any new contact info, and optionally append a
// negotiation note. Returns the owner. Idempotent — re-confirming just updates + re-links.
export async function confirmOwnerForDeal(
  dealId: string,
  input: OwnerInput & { negotiation_append?: string | null; owner_id?: string | null },
  by: string | null,
): Promise<DealOwner> {
  let owner: DealOwner | null = null;
  if (input.owner_id) owner = await getOwner(input.owner_id);
  if (!owner) owner = await findOwner({ name: input.name, emails: input.emails });
  if (owner) {
    owner = await updateOwner(owner.id, {
      name: input.name || owner.name,
      kind: input.kind || owner.kind,
      company: input.company ?? owner.company,
      reachability: input.reachability ?? owner.reachability,
      emails_add: input.emails, phones_add: input.phones, links_add: input.links,
      ...(input.notes ? { notes: owner.notes ? `${owner.notes}\n${input.notes}` : input.notes } : {}),
      ...(input.negotiation_append ? { negotiation_append: input.negotiation_append } : {}),
    }, by);
  } else {
    owner = await createOwner({ ...input, negotiation_notes: input.negotiation_append || input.negotiation_notes || null }, by);
  }
  await linkDealOwner(dealId, owner.id);
  return owner;
}

// Lightweight typeahead for the confirm/link modal — id + name + primary email.
export async function searchOwnersTypeahead(q: string, limit = 8): Promise<{ id: string; name: string; email: string | null; company: string | null }[]> {
  const s = String(q || "").trim();
  if (s.length < 2) return [];
  const owners = await listOwners({ q: s, limit });
  return owners.slice(0, limit).map((o) => ({ id: o.id, name: o.name, email: (o.emails || [])[0] || null, company: o.company }));
}
