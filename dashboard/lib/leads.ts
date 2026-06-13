// Leads report — the ACTUAL contact-form submissions (name, email, domains of
// interest, self-reported source), parsed from the notification emails, with a
// best-effort tie-back to revenue via the Domain Tracker's Deals tab.
//
// Why email: GA (and the bundled historical export) are anonymized — they have
// counts + a self-reported-source breakdown but no PII. Every submission, though,
// emails inquiry@snagged.com via Zapier with a clean labeled body:
//   Name / Email / Acquire or Sell? / Domains / Message / Budget / Owner Contact? /
//   How Did You Hear About Us? / Location
// inquiry@ is a group (not impersonable), but its mail lands in the team boxes
// (rob@/brian@, .com + .co) which our read-only Gmail integration CAN read. So we
// search those for the Zapier submissions and parse each one.
//
// Revenue tie-back: the Payments tab has no client name ("Lead" = the Snagged
// owner), but the Deals tab does — Deal Name (domain) · Contact · Email · Status ·
// Acquisition Price. We match each lead by email → name → domain-of-interest and
// attach the deal (and any Payments $ on that domain). Won't always hit; that's fine.

import { dealMailboxes, gmailConfigured, searchMessages, getMessage, type GmailMessage } from "./gmail";
import { getSheetValues } from "./sheets";

const SHEET_ID = process.env.SNAGGED_TRACKER_SHEET_ID || "1TVAJ2ef_rM03pHZ9rq8C3W4BgyiSBiOc5j7jAbFzGTA";

export type LabelValue = { label: string; value: number };
export type LeadMatch = {
  dealName: string;
  contact: string | null;
  status: string | null;
  acquisitionPrice: number | null;
  clientPaid: number | null; // summed from Payments for the matched domain, when present
  via: "email" | "name" | "domain";
};
export type Lead = {
  date: string;          // YYYY-MM-DD (email date, ET-ish)
  name: string;
  email: string;
  domains: string[];     // domains of interest
  source: string | null; // "How Did You Hear About Us?"
  intent: string | null; // "Acquire or Sell?"
  budget: string | null;
  location: string | null;
  message: string | null;
  match: LeadMatch | null;
};
export type LeadsReport = {
  configured: boolean;
  total: number;
  matched: number;
  bySource: LabelValue[];
  leads: Lead[];
};

export function leadsConfigured(): boolean {
  return gmailConfigured();
}

// "X / Twitter" canonicalization (matches the GA self-reported label the Ads ROI uses).
export function canonicalSource(raw: string | null): string {
  const s = (raw || "").trim();
  if (!s) return "(unknown)";
  if (/\b(x|twitter)\b/i.test(s) || s.toLowerCase() === "x") return "X / Twitter";
  return s.replace(/\s+/g, " ");
}
export function isXSource(raw: string | null): boolean {
  return canonicalSource(raw) === "X / Twitter";
}

const stripCtl = (s: string) => s.replace(/[\u0000-\u001F\u00A0\u200B-\u200F\u2028\u2029\u202F\u2060\uFEFF]/g, "").trim();
const normEmail = (s: string) => (s || "").trim().toLowerCase();
const normName = (s: string) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
// SLD token of a domain-ish string (drop scheme/path/TLD) for fuzzy domain matching.
function sld(d: string): string {
  const m = String(d || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/\s]/)[0];
  const host = m.split(".")[0];
  return host.replace(/[^a-z0-9]/g, "");
}

function field(body: string, label: string): string {
  // Labels look like "Name:" or "Acquire or Sell?" — capture the rest of the line.
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*([^\\n\\r]*)", "i");
  const m = body.match(re);
  return m ? stripCtl(m[1]) : "";
}

// Parse a Zapier "New Submission from …" email into a Lead (pre-match).
function parseLead(msg: GmailMessage): Lead | null {
  const body = msg.body || "";
  // Subject backup: "New Submission from {Name} ({email})"
  const subj = msg.subject.match(/New Submission from\s+(.+?)\s*\(([^)]+)\)/i);
  const name = field(body, "Name:") || (subj ? subj[1].trim() : "") || msg.fromName;
  const email = normEmail(field(body, "Email:") || (subj ? subj[2] : ""));
  if (!name && !email) return null;
  const domainsRaw = field(body, "Domains:");
  const domains = domainsRaw
    ? domainsRaw.split(/[,\s/]+/).map((d) => d.trim()).filter((d) => d && d.length > 1)
    : [];
  const d = new Date(msg.date);
  const date = Number.isFinite(msg.date) && msg.date > 0
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
    : "";
  return {
    date,
    name: name.trim(),
    email,
    domains,
    source: field(body, "How Did You Hear About Us\\?") || null,
    intent: field(body, "Acquire or Sell\\?") || null,
    budget: field(body, "Budget:") || null,
    location: field(body, "Location:") || null,
    message: field(body, "Message:") || null,
    match: null,
  };
}

type Deal = { dealName: string; sld: string; contact: string; email: string; status: string; acq: number | null };

function money(v: string | undefined): number | null {
  if (!v) return null;
  const x = Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(x) ? x : null;
}
function indexer(header: string[]): (name: string) => number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const map = new Map(header.map((h, i) => [norm(h), i]));
  return (name: string) => map.get(norm(name)) ?? -1;
}

// Read the Deals tab + a domain→Client Paid index from Payments for the tie-back.
async function loadRevenueIndex(): Promise<{ deals: Deal[]; paidByDomain: Map<string, number> }> {
  const [dealRows, payRows] = await Promise.all([
    getSheetValues(SHEET_ID, "Deals!A1:L5000").catch(() => [] as string[][]),
    getSheetValues(SHEET_ID, "Payments!A1:N5000").catch(() => [] as string[][]),
  ]);
  const deals: Deal[] = [];
  if (dealRows.length) {
    const c = indexer(dealRows[0]);
    const dn = c("Deal Name"), ct = c("Contact"), em = c("Email"), st = c("Status"), ap = c("Acquisition Price");
    for (let i = 1; i < dealRows.length; i++) {
      const r = dealRows[i];
      const dealName = (r[dn] || "").trim();
      if (!dealName) continue;
      deals.push({ dealName, sld: sld(dealName), contact: (r[ct] || "").trim(), email: normEmail(r[em]), status: (r[st] || "").trim(), acq: money(r[ap]) });
    }
  }
  const paidByDomain = new Map<string, number>();
  if (payRows.length) {
    const c = indexer(payRows[0]);
    const dom = c("Domain Names"), paid = c("Client Paid");
    for (let i = 1; i < payRows.length; i++) {
      const r = payRows[i];
      const s = sld(r[dom] || "");
      if (!s) continue;
      paidByDomain.set(s, (paidByDomain.get(s) || 0) + (money(r[paid]) || 0));
    }
  }
  return { deals, paidByDomain };
}

function matchLead(lead: Lead, deals: Deal[], paidByDomain: Map<string, number>): LeadMatch | null {
  const byEmail = lead.email ? deals.find((d) => d.email && d.email === lead.email) : null;
  const byName = !byEmail && lead.name ? deals.find((d) => d.contact && normName(d.contact) === normName(lead.name)) : null;
  const leadSlds = new Set(lead.domains.map(sld).filter(Boolean));
  const byDomain = !byEmail && !byName && leadSlds.size ? deals.find((d) => leadSlds.has(d.sld)) : null;
  const deal = byEmail || byName || byDomain;
  if (!deal) return null;
  const via: LeadMatch["via"] = byEmail ? "email" : byName ? "name" : "domain";
  const clientPaid = paidByDomain.get(deal.sld) ?? null;
  return { dealName: deal.dealName, contact: deal.contact || null, status: deal.status || null, acquisitionPrice: deal.acq, clientPaid, via };
}

const gmailDate = (iso: string) => iso.replace(/-/g, "/"); // YYYY-MM-DD → YYYY/MM/DD (Gmail query)

export async function leadsReport(from: string, to: string): Promise<LeadsReport> {
  const empty: LeadsReport = { configured: leadsConfigured(), total: 0, matched: 0, bySource: [], leads: [] };
  if (!leadsConfigured()) return empty;

  // before: is exclusive → bump one day so the `to` date is included.
  const toPlus = new Date(to + "T00:00:00Z"); toPlus.setUTCDate(toPlus.getUTCDate() + 1);
  const beforeStr = `${toPlus.getUTCFullYear()}/${String(toPlus.getUTCMonth() + 1).padStart(2, "0")}/${String(toPlus.getUTCDate()).padStart(2, "0")}`;
  const q = `from:zapiermail.com subject:"New Submission from" after:${gmailDate(from)} before:${beforeStr}`;

  // Collect submission messages across the team mailboxes (the inquiry@ group fans
  // out to them), dedupe by RFC Message-ID (same submission lands in several boxes).
  const mailboxes = dealMailboxes();
  const seen = new Set<string>();
  const leads: Lead[] = [];
  const [{ deals, paidByDomain }] = await Promise.all([loadRevenueIndex()]);

  for (const mb of mailboxes) {
    let stubs: { id: string; threadId: string }[] = [];
    try { stubs = await searchMessages(mb, q, 250); } catch { continue; }
    // Fetch message bodies with bounded concurrency.
    for (let i = 0; i < stubs.length; i += 8) {
      const batch = stubs.slice(i, i + 8);
      const msgs = await Promise.all(batch.map((s) => getMessage(mb, s.id).catch(() => null)));
      for (const msg of msgs) {
        if (!msg) continue;
        if (seen.has(msg.mid)) continue;
        seen.add(msg.mid);
        // Only the Zapier submission emails (skip stray replies that match loosely).
        if (!/zapiermail\.com/i.test(msg.from) || !/New Submission from/i.test(msg.subject)) continue;
        const lead = parseLead(msg);
        if (!lead || !lead.date || lead.date < from || lead.date > to) continue;
        lead.match = matchLead(lead, deals, paidByDomain);
        leads.push(lead);
      }
    }
  }

  leads.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
  const srcCounts = new Map<string, number>();
  for (const l of leads) srcCounts.set(canonicalSource(l.source), (srcCounts.get(canonicalSource(l.source)) || 0) + 1);
  const bySource = [...srcCounts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  return { configured: true, total: leads.length, matched: leads.filter((l) => l.match).length, bySource, leads };
}
