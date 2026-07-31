// Email-health report builder + cache. Runs the MXToolbox checks for our sending domains,
// distills each into a pass/warn/fail with the record value + issues, grades the domain, and
// caches the result (checks cost DNS/network quota, so the Reports page reads the cache and a
// Refresh / daily cron re-runs). All best-effort + fail-open.

import { getDb, isDbConfigured } from "../supabase";
import { mxLookup, usage, type MxLookup, type MxItem, type MxUsage } from "./mxtoolbox";

const T = "email_health_checks";

// Configured sending domains + DKIM selectors (env-overridable).
export function healthDomains(): string[] {
  const raw = (process.env.EMAIL_HEALTH_DOMAINS || "snagged.com,snagged.co").split(/[,\s]+/);
  return [...new Set(raw.map((d) => d.trim().toLowerCase()).filter(Boolean))];
}
export function dkimSelectors(): string[] {
  // Google Workspace signs with the `google` selector; Resend with `resend`. Add more via env.
  const raw = (process.env.EMAIL_HEALTH_DKIM_SELECTORS || "google,resend").split(/[,\s]+/);
  return [...new Set(raw.map((s) => s.trim()).filter(Boolean))];
}

export type CheckStatus = "pass" | "warn" | "fail" | "unavailable";
export type Check = {
  key: string;          // mx | spf | dkim | dmarc | blacklist | dns
  label: string;
  status: CheckStatus;
  value: string | null; // the record / representative info (e.g. the SPF string)
  detail: string | null; // selector used, or an "unavailable" reason
  failed: MxItem[];
  warnings: MxItem[];
};
export type DomainHealth = {
  domain: string;
  grade: "A" | "B" | "F" | "?";
  checks: Check[];
  failing: string[];    // check keys currently failing — the alert set
  checked_at: string;
};

function item(a?: MxItem[]): MxItem[] { return Array.isArray(a) ? a : []; }

// Distill an MxLookup (or an errored result) into a Check.
function toCheck(key: string, label: string, r: { ok: boolean; data: MxLookup | null; error: string | null }, detail: string | null = null): Check {
  if (!r.ok || !r.data) {
    return { key, label, status: "unavailable", value: null, detail: r.error || detail || "no data", failed: [], warnings: [] };
  }
  const failed = item(r.data.Failed);
  const warnings = item(r.data.Warnings);
  const passed = item(r.data.Passed);
  const status: CheckStatus = failed.length ? "fail" : warnings.length ? "warn" : passed.length ? "pass" : "unavailable";
  // Representative value: the record string lives in a Passed/Warning Info, else Information.
  const value = passed[0]?.Info || warnings[0]?.Info || failed[0]?.Info
    || (r.data.Information && r.data.Information[0] ? JSON.stringify(r.data.Information[0]).slice(0, 200) : null);
  return { key, label, status, value: value || null, detail, failed, warnings };
}

function gradeFor(checks: Check[]): DomainHealth["grade"] {
  const real = checks.filter((c) => c.status !== "unavailable");
  if (!real.length) return "?";
  if (real.some((c) => c.status === "fail")) return "F";
  if (real.some((c) => c.status === "warn")) return "B";
  return "A";
}

// Build a live report for one domain (spends quota). DKIM tries each selector and keeps the
// best-passing one. Blacklist is best-effort (network quota; free plan → "unavailable").
export async function checkDomain(domain: string, selectors = dkimSelectors()): Promise<DomainHealth> {
  const [mx, spf, dmarc, dns, blacklist] = await Promise.all([
    mxLookup.mx(domain), mxLookup.spf(domain), mxLookup.dmarc(domain), mxLookup.dns(domain), mxLookup.blacklist(domain),
  ]);
  // DKIM: try each selector, prefer a pass, else a warn, else the first result.
  const dkimResults = await Promise.all(selectors.map(async (sel) => ({ sel, r: await mxLookup.dkim(domain, sel) })));
  let dkimCheck: Check | null = null;
  for (const { sel, r } of dkimResults) {
    const c = toCheck("dkim", "DKIM", r, `selector: ${sel}`);
    if (!dkimCheck || (c.status === "pass") || (c.status === "warn" && dkimCheck.status !== "pass")) dkimCheck = c;
    if (c.status === "pass") break;
  }
  if (!dkimCheck) dkimCheck = { key: "dkim", label: "DKIM", status: "unavailable", value: null, detail: "no selector matched", failed: [], warnings: [] };

  const checks: Check[] = [
    toCheck("mx", "MX", mx),
    toCheck("spf", "SPF", spf),
    dkimCheck,
    toCheck("dmarc", "DMARC", dmarc),
    toCheck("blacklist", "Blacklist", blacklist),
    toCheck("dns", "DNS health", dns),
  ];
  const failing = checks.filter((c) => c.status === "fail").map((c) => c.key);
  return { domain, grade: gradeFor(checks), checks, failing, checked_at: new Date().toISOString() };
}

// Refresh the configured domains (or a single one), persist, and return the reports + quota usage.
export async function refreshHealth(only?: string): Promise<{ reports: DomainHealth[]; usage: MxUsage | null }> {
  const domains = only ? [only.toLowerCase()] : healthDomains();
  const reports: DomainHealth[] = [];
  for (const d of domains) {                       // sequential — respect the DNS quota
    const rep = await checkDomain(d).catch(() => null);
    if (rep) { reports.push(rep); await saveReport(rep); }
  }
  const u = await usage();
  return { reports, usage: u.ok ? u.data : null };
}

// ── Cache (main project) ────────────────────────────────────────────────────
export async function saveReport(rep: DomainHealth): Promise<void> {
  if (!isDbConfigured()) return;
  const row = { domain: rep.domain, grade: rep.grade, failing: rep.failing, report: rep, checked_at: rep.checked_at };
  await getDb().from(T).upsert(row, { onConflict: "domain" });
}
export async function listReports(): Promise<DomainHealth[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().from(T).select("report").order("domain", { ascending: true });
  if (error || !data) return [];
  return (data as { report: DomainHealth }[]).map((r) => r.report).filter(Boolean);
}
export async function getStoredFailing(): Promise<Record<string, string[]>> {
  if (!isDbConfigured()) return {};
  const { data } = await getDb().from(T).select("domain,failing");
  const out: Record<string, string[]> = {};
  for (const r of (data as { domain: string; failing: string[] }[] | null) || []) out[r.domain] = r.failing || [];
  return out;
}
