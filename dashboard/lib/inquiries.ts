// Buy-side inquiry triage queue. Reads the ENRICHED inbound leads the research app
// already produces (domain_research_leads in the shared main project — the same DB
// admin's getDb() points at) and shapes them for the triage table: buyer, company,
// VIP band, the form's intent/budget, the triage route, and the research dossier link.
//
// These are the inquiry@snagged.com contact-form submissions (Zapier → the research
// /api/lead-enrich POST), which run a person deep-dive + Apollo firmographics + a free
// Domain Owner report per named domain. Here we surface the BUY-side ones (intent =
// Acquire) so a human can one-click convert each into a Pipedrive deal.

import { getDb } from "./supabase";

const LEADS = "domain_research_leads";
const RESEARCH_BASE = (process.env.RESEARCH_APP_BASE || "https://app.snagged.com/research").replace(/\/+$/, "");

export type Inquiry = {
  leadKey: string;
  name: string | null;
  email: string | null;
  companyDomain: string | null;
  domains: string[];           // parsed from domain_of_interest (an inquiry can name several)
  requested: string | null;    // raw domain_of_interest (may be free text / not a real domain)
  intent: string | null;
  isBuySide: boolean;          // intent looks like acquire/buy
  budget: string | null;
  message: string | null;
  location: string | null;
  tier: string | null;         // vip | notable | standard (research triage)
  routeTo: string | null;      // "Rob (reply personally)" / "Brian" / "Team (round-robin)"
  suggestedAssigneeEmail: string | null;
  reasons: string[];
  vip: { band: string | null; followers: number | null } | null;
  company: { name: string | null; funding: string | null; employees: number | null; revenue: string | null } | null;
  status: string | null;       // enrichment status: pending | ready | failed
  dossierUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
  dismissed: boolean;          // ignored as spam/test
};

function looksBuySide(intent: string | null): boolean {
  const s = (intent || "").toLowerCase();
  if (!s) return true;                       // unknown intent → keep (don't hide a real lead)
  if (/\bsell\b|selling|list|apprais/.test(s) && !/acqui|buy|purchas/.test(s)) return false;
  return true;                               // acquire / buy / purchase / anything not clearly sell
}

function parseDomains(raw: string | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of String(raw || "").split(/[,;|/\s]+|\band\b/i)) {
    const d = tok.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
    if (!d || !d.includes(".") || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out;
}

// VIP → Rob, Notable → Brian, else team inbox. Mirrors the research dossier routing.
function routeForTier(tier: string | null): { routeTo: string | null; email: string | null } {
  const t = (tier || "").toLowerCase();
  if (t === "vip") return { routeTo: "Rob (reply personally)", email: "rob@snagged.com" };
  if (t === "notable") return { routeTo: "Brian", email: "brian@snagged.com" };
  if (t === "standard") return { routeTo: "Team (round-robin)", email: null };
  return { routeTo: null, email: null };
}

type LeadRow = {
  lead_key: string; email: string | null; name: string | null; company_domain: string | null;
  domain_of_interest: string | null; intent: string | null; budget: string | null;
  form: Record<string, unknown> | null; status: string | null; tier: string | null;
  result: Record<string, unknown> | null; dismissed: boolean | null; created_at: string | null; updated_at: string | null;
};

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function mapRow(r: LeadRow): Inquiry {
  const form = (r.form || {}) as Record<string, unknown>;
  const result = (r.result || {}) as Record<string, unknown>;
  const triage = (result.triage || {}) as Record<string, unknown>;
  const person = (result.person || {}) as Record<string, unknown>;
  const vipObj = (person.vip || {}) as Record<string, unknown>;
  const company = (result.company || {}) as Record<string, unknown>;
  const tier = (r.tier || (triage.tier as string) || null) as string | null;
  const route = routeForTier(tier);
  const hasCompany = company && (company.company || company.funding || company.employees || company.revenue);
  return {
    leadKey: r.lead_key,
    name: r.name,
    email: r.email,
    companyDomain: r.company_domain,
    domains: parseDomains(r.domain_of_interest),
    requested: r.domain_of_interest ? String(r.domain_of_interest).trim() : null,
    intent: r.intent,
    isBuySide: looksBuySide(r.intent),
    budget: r.budget || null,
    message: (form.message as string) || (form.Message as string) || null,
    location: (form.location as string) || (form.Location as string) || null,
    tier,
    routeTo: (triage.route_to as string) || route.routeTo,
    suggestedAssigneeEmail: route.email,
    reasons: Array.isArray(triage.reasons) ? (triage.reasons as string[]).slice(0, 6) : [],
    vip: person.vip ? { band: (vipObj.band as string) || null, followers: num(person.max_followers) } : null,
    company: hasCompany
      ? {
          name: (company.company as string) || r.company_domain,
          funding: (company.funding as string) || null,
          employees: num(company.employees),
          revenue: (company.revenue as string) || null,
        }
      : null,
    status: r.status,
    dossierUrl: `${RESEARCH_BASE}/#/lead/${r.lead_key}`,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    dismissed: r.dismissed === true,
  };
}

// List recent inquiries. Buy-side only by default; includeSell=true returns everything
// (with an isBuySide flag so the client can label the sell-side ones).
export async function listBuyInquiries({ limit = 100, includeSell = false, includeDismissed = false, q = "" }: { limit?: number; includeSell?: boolean; includeDismissed?: boolean; q?: string } = {}): Promise<{ configured: boolean; inquiries: Inquiry[] }> {
  const { isDbConfigured } = await import("./supabase");
  if (!isDbConfigured()) return { configured: false, inquiries: [] };

  // Run the query with the `dismissed` column; if it isn't there yet (migration not
  // applied), retry WITHOUT it so the queue still loads — every row just reads as
  // not-dismissed until the column + backfill land.
  async function run(withDismissed: boolean) {
    const cols = withDismissed
      ? "lead_key,email,name,company_domain,domain_of_interest,intent,budget,form,status,tier,result,dismissed,created_at,updated_at"
      : "lead_key,email,name,company_domain,domain_of_interest,intent,budget,form,status,tier,result,created_at,updated_at";
    let query = getDb().from(LEADS).select(cols).order("created_at", { ascending: false }).limit(Math.min(limit, 300));
    // dismissed IS NOT TRUE keeps null (pre-backfill) + false, hides the ignored ones.
    if (withDismissed && !includeDismissed) query = query.not("dismissed", "is", true);
    if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,domain_of_interest.ilike.%${q}%`);
    return query;
  }

  let { data, error } = await run(true);
  if (error && /column|dismissed/i.test(error.message)) ({ data, error } = await run(false));
  if (error) throw new Error(`listBuyInquiries: ${error.message}`);
  // For now, show every buy-side lead in the queue — even one whose requested "domain" didn't
  // parse to a real domain (free text / a street address like "9254 winnetka ave", often spam):
  // surface it (flagged "not a domain" in the UI) so nothing is silently hidden, and let a human
  // dismiss it. Sell-side view still requires a parsed domain to keep noise down.
  let inquiries = (data as unknown as LeadRow[] || []).map(mapRow);
  inquiries = includeSell
    ? inquiries.filter((i) => i.isBuySide || i.domains.length > 0)
    : inquiries.filter((i) => i.isBuySide);
  return { configured: true, inquiries };
}

// How many pending (buy-side, not-dismissed) inquiries are in the queue — for the board's
// Inbox → Buy-Side Inquiries pointer. Fail-open to 0 (never break the board).
export async function countBuyInquiries(): Promise<number> {
  try {
    const { inquiries } = await listBuyInquiries({ limit: 300 });
    return inquiries.length;
  } catch { return 0; }
}

// Dismiss/ignore (or restore) an inquiry. Best-effort strip+retry if the columns
// aren't there yet (before the migration runs).
export async function setInquiryDismissed(leadKey: string, dismissed: boolean, by: string): Promise<void> {
  const patch = { dismissed, dismissed_by: dismissed ? by : null, dismissed_at: dismissed ? new Date().toISOString() : null };
  const res = await getDb().from(LEADS).update(patch).eq("lead_key", leadKey);
  if (res.error) {
    // Column missing → degrade gracefully (no-op) until the migration is applied.
    if (/column|dismissed/i.test(res.error.message)) return;
    throw new Error(`setInquiryDismissed: ${res.error.message}`);
  }
}
