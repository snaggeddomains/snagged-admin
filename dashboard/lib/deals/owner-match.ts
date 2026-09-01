// "Have we worked with this owner before?" — the cross-app matcher behind the Domain Owner
// report's known-owner banner (research app calls this via an internal endpoint). Given a
// domain (+ optionally the report's identified owner name/email), find any matching owner in
// our directory and return the names we've closed with them + the Snagged point(s) of contact.
//
// Match precedence (most→least reliable):
//   1. DOMAIN — this exact name is on a buy-side `deals` row or a confirmed Owner Review card.
//   2. EMAIL — the identified owner email overlaps a deal_owners.emails.
//   3. NAME  — exact (case-insensitive) deal_owners.name, only when the name is specific.
// Fail-soft: any missing table / column just yields no match (research shows no banner).

import { getDb, isDbConfigured } from "../supabase";

const OWNERS = "deal_owners";
const DEALS = "deals";
const CARDS = "owner_review_cards";
const USERS = "domain_research_users";

export type OwnerMatch = {
  id: string;
  name: string;
  company: string | null;
  domains: string[];          // every name we've worked with them (deals + confirmed cards)
  contacts: string[];         // Snagged point(s) of contact, by display name
  deal_count: number;
  negotiation_notes: string | null;
  url: string;
  matched_by: "domain" | "email" | "name";
};

const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();
const clean = (s: unknown) => String(s ?? "").trim();

function base(): string {
  return (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/$/, "");
}

// Resolve a set of Snagged emails → display names (first+last, else email). One query.
async function namesFor(emails: string[]): Promise<Map<string, string>> {
  const want = [...new Set(emails.map(lc).filter(Boolean))];
  const out = new Map<string, string>();
  if (!want.length) return out;
  try {
    const { data } = await getDb().from(USERS).select("email,first_name,last_name").in("email", want);
    for (const u of (data as { email: string; first_name: string | null; last_name: string | null }[]) || []) {
      const nm = [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email;
      out.set(lc(u.email), nm);
    }
  } catch { /* best-effort */ }
  return out;
}

export async function matchOwnersForResearch(input: { domain?: string; email?: string; name?: string }): Promise<OwnerMatch[]> {
  if (!isDbConfigured()) return [];
  const domain = lc(input.domain);
  const email = lc(input.email);
  const name = clean(input.name);
  // A name is "specific" enough to match on only if it has a space (First Last) or is ≥5 chars —
  // avoids matching a bare common token.
  const nameSpecific = name && (name.includes(" ") || name.length >= 5) ? name : "";

  // ownerId → how we first matched it (domain wins).
  const matchedBy = new Map<string, OwnerMatch["matched_by"]>();
  const setMatch = (id: string | null | undefined, by: OwnerMatch["matched_by"]) => {
    if (!id) return;
    if (!matchedBy.has(id)) matchedBy.set(id, by);
  };

  // 1. DOMAIN → owner (via a deal or a confirmed card for this exact name).
  if (domain) {
    try {
      const { data } = await getDb().from(DEALS).select("domain_owner_id").eq("domain", domain);
      for (const r of (data as { domain_owner_id: string | null }[]) || []) setMatch(r.domain_owner_id, "domain");
    } catch { /* best-effort */ }
    try {
      const { data } = await getDb().from(CARDS).select("deal_owner_id").eq("domain", domain).eq("status", "confirmed");
      for (const r of (data as { deal_owner_id: string | null }[]) || []) setMatch(r.deal_owner_id, "domain");
    } catch { /* card table may not exist */ }
  }

  // 2. EMAIL overlap.
  if (email && /@/.test(email)) {
    try {
      const { data } = await getDb().from(OWNERS).select("id").overlaps("emails", [email]).limit(5);
      for (const r of (data as { id: string }[]) || []) setMatch(r.id, "email");
    } catch { /* best-effort */ }
  }

  // 3. Exact name.
  if (nameSpecific) {
    try {
      const { data } = await getDb().from(OWNERS).select("id").ilike("name", nameSpecific).limit(5);
      for (const r of (data as { id: string }[]) || []) setMatch(r.id, "name");
    } catch { /* best-effort */ }
  }

  const ids = [...matchedBy.keys()];
  if (!ids.length) return [];

  // Owner records.
  const { data: owners } = await getDb().from(OWNERS).select("id,name,company,negotiation_notes").in("id", ids);
  const ownerById = new Map((owners as { id: string; name: string; company: string | null; negotiation_notes: string | null }[] || []).map((o) => [o.id, o]));

  // Domains + points of contact from BOTH sources, in bulk.
  const domainsBy = new Map<string, Set<string>>();
  const contactsBy = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, id: string, v: string | null | undefined) => { if (!v) return; if (!m.has(id)) m.set(id, new Set()); m.get(id)!.add(v); };

  try {
    const { data } = await getDb().from(DEALS).select("domain,owner_email,domain_owner_id").in("domain_owner_id", ids);
    for (const r of (data as { domain: string | null; owner_email: string | null; domain_owner_id: string | null }[]) || []) {
      if (!r.domain_owner_id) continue;
      add(domainsBy, r.domain_owner_id, lc(r.domain));
      add(contactsBy, r.domain_owner_id, lc(r.owner_email));
    }
  } catch { /* best-effort */ }
  try {
    const { data } = await getDb().from(CARDS).select("domain,deal_owner_id,reviewed_by,assigned_to").in("deal_owner_id", ids).eq("status", "confirmed");
    for (const r of (data as { domain: string | null; deal_owner_id: string | null; reviewed_by: string | null; assigned_to: string | null }[]) || []) {
      if (!r.deal_owner_id) continue;
      add(domainsBy, r.deal_owner_id, lc(r.domain));
      add(contactsBy, r.deal_owner_id, lc(r.reviewed_by || r.assigned_to));
    }
  } catch { /* card table may not exist */ }

  // Resolve contact emails → names.
  const allContactEmails = [...contactsBy.values()].flatMap((s) => [...s]);
  const nameMap = await namesFor(allContactEmails);

  const results: OwnerMatch[] = ids.map((id) => {
    const o = ownerById.get(id);
    const domains = [...(domainsBy.get(id) || new Set<string>())].sort();
    const contacts = [...(contactsBy.get(id) || new Set<string>())].map((e) => nameMap.get(e) || e);
    return {
      id,
      name: o?.name || "(unnamed owner)",
      company: o?.company || null,
      domains,
      contacts,
      deal_count: domains.length,
      negotiation_notes: o?.negotiation_notes || null,
      url: `${base()}/deals/owners/${id}`,
      matched_by: matchedBy.get(id)!,
    };
  }).filter((m) => ownerById.has(m.id));

  // Domain matches first, then most domains closed.
  const rank = { domain: 0, email: 1, name: 2 };
  results.sort((a, b) => (rank[a.matched_by] - rank[b.matched_by]) || (b.deal_count - a.deal_count));
  return results;
}
