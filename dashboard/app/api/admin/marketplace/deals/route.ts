// Reports → Marketplace → per-domain ACTIVITY drill-down (sell-side).
// On-demand: reconstructs + classifies the domain's buyer threads from the deal
// mailboxes (a few minutes the first time), caches the result in Supabase, and
// returns it alongside the per-domain GA stats for the selected window + the
// newsletter inclusion. Read-only. Gated reports.marketplace.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { analyticsReport, gaConfigured, type MarketplaceReport } from "@/lib/ga";
import { getNewsletterFeatures, summarizeNewsletter } from "@/lib/newsletter";
import { buildDealReport, REPORT_VERSION, type DealReport } from "@/lib/marketplace-deals";
import { gmailConfigured } from "@/lib/gmail";
import { withGmailFeature, isGmailBudgetError, GMAIL_BUDGET_MESSAGE } from "@/lib/gmail-budget";
import { getDb, isDbConfigured } from "@/lib/supabase";

export const runtime = "nodejs";
export const maxDuration = 300; // generation scans many threads — give it room

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TABLE = "marketplace_deal_reports";
const FRESH_MS = 6 * 60 * 60 * 1000; // re-use a cached report for 6h

async function readCache(domain: string): Promise<{ report: DealReport; generatedAt: string } | null> {
  if (!isDbConfigured()) return null;
  try {
    const { data } = await getDb().from(TABLE).select("report,generated_at").eq("domain", domain).maybeSingle();
    // Rebuild any report cached under an older computation (the `reportVersion`
    // marker is bumped in marketplace-deals.ts whenever the logic changes) so a
    // stale cache never serves an outdated categorization.
    if (data?.report && (data.report as Record<string, unknown>).reportVersion === REPORT_VERSION) {
      return { report: data.report as DealReport, generatedAt: data.generated_at };
    }
  } catch { /* table may not exist yet — treat as miss */ }
  return null;
}
async function writeCache(domain: string, report: DealReport): Promise<string> {
  const generatedAt = new Date().toISOString();
  if (isDbConfigured()) {
    try { await getDb().from(TABLE).upsert({ domain, report, generated_at: generatedAt }, { onConflict: "domain" }); }
    catch { /* best-effort cache */ }
  }
  return generatedAt;
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!canReports(me, "reports.marketplace")) {
    return NextResponse.json({ error: "No access to the Marketplace report" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const domain = (sp.get("domain") || "").toLowerCase().trim().replace(/^www\./, "");
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
    return NextResponse.json({ error: "Provide a valid ?domain=" }, { status: 400 });
  }
  const from = isDate(sp.get("from")) ? (sp.get("from") as string) : etYmd(new Date(Date.now() - 89 * 86400000));
  const to = isDate(sp.get("to")) ? (sp.get("to") as string) : etYmd(new Date());
  const force = sp.get("refresh") === "1";

  // Deal activity (cached) + GA stats (live, fast) + newsletter (all-time) in parallel.
  const dealsP = (async () => {
    if (!gmailConfigured()) return { report: null as DealReport | null, generatedAt: null as string | null, configured: false, budgetPaused: false };
    if (!force) {
      const hit = await readCache(domain);
      if (hit && Date.now() - Date.parse(hit.generatedAt) < FRESH_MS) {
        return { report: hit.report, generatedAt: hit.generatedAt, configured: true, budgetPaused: false };
      }
    }
    // Governed background read — halts at the Gmail safety line. If we're paused, serve a stale
    // cache (if any) rather than spending more of the shared quota; never a 500.
    try {
      const report = await withGmailFeature("marketplace-deals", () => buildDealReport(domain));
      const generatedAt = await writeCache(domain, report);
      return { report, generatedAt, configured: true, budgetPaused: false };
    } catch (e) {
      if (!isGmailBudgetError(e)) throw e;
      const stale = await readCache(domain).catch(() => null);
      return { report: stale?.report ?? null, generatedAt: stale?.generatedAt ?? null, configured: true, budgetPaused: true, budgetMessage: GMAIL_BUDGET_MESSAGE };
    }
  })();

  const gaP = (async () => {
    if (!gaConfigured()) return null;
    try {
      const rep = (await analyticsReport("marketplace", from, to)) as MarketplaceReport;
      return rep.listings.find((l) => l.domain.toLowerCase() === domain) || { domain, path: "", views: 0, sessions: 0, users: 0, inquiryStarts: 0, clicks: 0, inquiries: 0 };
    } catch { return null; }
  })();

  // Newsletter: both the summary (counts) AND the per-send list (date · subject ·
  // MailChimp archive link) so the report can show the full breakdown.
  const nlP = getNewsletterFeatures()
    .then((f) => ({ summary: summarizeNewsletter(f[domain]), features: f[domain] || [] }))
    .catch(() => ({ summary: null as ReturnType<typeof summarizeNewsletter> | null, features: [] as Awaited<ReturnType<typeof getNewsletterFeatures>>[string] }));

  try {
    const [deals, ga, nl] = await Promise.all([dealsP, gaP, nlP]);
    return NextResponse.json({ ok: true, domain, from, to, deals, ga, newsletter: nl.summary, newsletterFeatures: nl.features });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error)?.message || e) }, { status: 500 });
  }
}
