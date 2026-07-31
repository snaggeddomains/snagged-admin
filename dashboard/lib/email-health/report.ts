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
export type SelectorStatus = { selector: string; status: CheckStatus };
export type ActionItem = { severity: "high" | "medium" | "low"; title: string; detail: string };
export type DomainHealth = {
  domain: string;
  grade: "A" | "B" | "F" | "?";
  checks: Check[];
  failing: string[];    // check keys currently failing — the alert set
  dmarc_policy: "none" | "quarantine" | "reject" | null;
  dmarc_reporting: boolean;      // rua= aggregate reporting present
  dkim_selectors: SelectorStatus[];
  actions: ActionItem[];         // Analysis → Action Items, computed each run
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

// The DMARC policy (p=) + whether aggregate reporting (rua=) is on, pulled from the raw record.
function parseDmarc(data: MxLookup | null): { policy: DomainHealth["dmarc_policy"]; reporting: boolean } {
  const raw = data ? JSON.stringify(data) : "";
  const m = /[;\s]p\s*=\s*(none|quarantine|reject)/i.exec(raw);
  return { policy: m ? (m[1].toLowerCase() as DomainHealth["dmarc_policy"]) : null, reporting: /rua\s*=\s*mailto:/i.test(raw) };
}

// Analysis → Action Items, derived from the checks each run (prioritized, self-clearing as fixed).
function buildActions(h: {
  domain: string; checks: Check[]; dmarcPolicy: DomainHealth["dmarc_policy"]; dmarcReporting: boolean;
  dkimSelectors: SelectorStatus[]; selectors: string[];
}): ActionItem[] {
  const A: ActionItem[] = [];
  const get = (k: string) => h.checks.find((c) => c.key === k);
  const dkimPass = h.dkimSelectors.filter((s) => s.status === "pass").map((s) => s.selector);
  const dkimMissing = h.dkimSelectors.filter((s) => s.status !== "pass").map((s) => s.selector);

  if (!dkimPass.length) {
    A.push({ severity: "high", title: `Publish a DKIM record for ${h.domain}`,
      detail: `No DKIM found on ${h.selectors.join(" / ")}. If ${h.domain} sends via Google Workspace, generate the key in Admin → Apps → Gmail → Authenticate email and publish the TXT at google._domainkey.${h.domain}, then Start authentication. If it sends via Resend, add the resend._domainkey record from the Resend dashboard. If it should NOT send, lock it: null MX + SPF "v=spf1 -all" + DMARC p=reject.` });
  } else if (dkimMissing.length) {
    A.push({ severity: "medium", title: `Add DKIM for ${dkimMissing.join(", ")} on ${h.domain}`,
      detail: `Only ${dkimPass.join(", ")} is signing. If you also send via ${dkimMissing.join("/")} (e.g. Resend), publish its DKIM so that mail is authenticated too — unsigned mail from a second ESP lands in spam.` });
  }

  const dmarc = get("dmarc");
  if (dmarc?.status === "fail" || !h.dmarcPolicy) {
    A.push({ severity: "high", title: `Add a DMARC record for ${h.domain}`,
      detail: `No enforceable DMARC policy. Start with p=none + rua reporting to monitor, then tighten to quarantine → reject.` });
  } else if (h.dmarcPolicy === "none") {
    A.push({ severity: "medium", title: `Tighten DMARC on ${h.domain} (p=none → quarantine → reject)`,
      detail: `DMARC is monitor-only, so spoofing isn't blocked and you miss the inbox-trust benefit. After confirming your senders (Google, Resend) pass in aggregate reports, move to quarantine, then reject.` });
  }
  if (h.dmarcPolicy && !h.dmarcReporting) {
    A.push({ severity: "low", title: `Turn on DMARC aggregate reporting for ${h.domain}`,
      detail: `Add rua=mailto:… (or a DMARC monitor like dmarcian / Postmark) so you can see every source sending as you before enforcing.` });
  }

  const bl = get("blacklist");
  if (bl?.status === "fail") {
    A.push({ severity: "high", title: `Delist ${h.domain} from blacklists`,
      detail: `Listed on: ${bl.failed.map((f) => f.Name || f.Info).filter(Boolean).join(", ")}. Request removal at each listing — a live blacklist tanks deliverability.` });
  }
  for (const k of ["spf", "mx"] as const) {
    const c = get(k);
    if (c?.status === "fail") A.push({ severity: "high", title: `Fix ${c.label} for ${h.domain}`, detail: c.failed.map((f) => f.Name || f.Info).filter(Boolean).join("; ") || `${c.label} check failed.` });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return A.sort((a, b) => order[a.severity] - order[b.severity]);
}

// Build a live report for one domain (spends quota). DKIM tries EVERY selector (all statuses kept
// for the analysis); the row shows the best. Blacklist is best-effort (network quota).
export async function checkDomain(domain: string, selectors = dkimSelectors()): Promise<DomainHealth> {
  const [mx, spf, dmarc, dns, blacklist] = await Promise.all([
    mxLookup.mx(domain), mxLookup.spf(domain), mxLookup.dmarc(domain), mxLookup.dns(domain), mxLookup.blacklist(domain),
  ]);
  const dkimResults = await Promise.all(selectors.map(async (sel) => ({ sel, c: toCheck("dkim", "DKIM", await mxLookup.dkim(domain, sel), `selector: ${sel}`) })));
  const dkimSelectors: SelectorStatus[] = dkimResults.map(({ sel, c }) => ({ selector: sel, status: c.status }));
  // The DKIM row = the best selector (a pass beats a warn beats a fail/unavailable).
  const rank: Record<CheckStatus, number> = { pass: 0, warn: 1, fail: 2, unavailable: 3 };
  const best = dkimResults.slice().sort((a, b) => rank[a.c.status] - rank[b.c.status])[0];
  const dkimCheck: Check = best?.c || { key: "dkim", label: "DKIM", status: "unavailable", value: null, detail: "no selector matched", failed: [], warnings: [] };

  const checks: Check[] = [
    toCheck("mx", "MX", mx),
    toCheck("spf", "SPF", spf),
    dkimCheck,
    toCheck("dmarc", "DMARC", dmarc),
    toCheck("blacklist", "Blacklist", blacklist),
    toCheck("dns", "DNS health", dns),
  ];
  const { policy: dmarc_policy, reporting: dmarc_reporting } = parseDmarc(dmarc.ok ? dmarc.data : null);
  const failing = checks.filter((c) => c.status === "fail").map((c) => c.key);
  const actions = buildActions({ domain, checks, dmarcPolicy: dmarc_policy, dmarcReporting: dmarc_reporting, dkimSelectors, selectors });
  // Grade: a records-valid domain that isn't ENFORCING DMARC (p=none) is a B, not an A —
  // it's spoofable and misses the deliverability benefit.
  let grade = gradeFor(checks);
  if (grade === "A" && dmarc_policy === "none") grade = "B";
  return { domain, grade, checks, failing, dmarc_policy, dmarc_reporting, dkim_selectors: dkimSelectors, actions, checked_at: new Date().toISOString() };
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
