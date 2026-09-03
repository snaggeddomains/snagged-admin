// One-time backfill/repair for deals.intent ("Acquire or Sell?"). Two passes:
//   A. RE-CANONICALIZE existing values — the inquiry form's answer is commonly the raw,
//      misspelled "Aquire a domain", so older converts stored that verbatim. normIntent maps
//      it to a clean "Acquire"/"Sell"; any row whose stored value isn't already canonical is
//      rewritten.
//   B. FILL NULLS from the lead form — match a deal to its domain_research_leads row by
//      lead_key first, else by buyer email, and write the canonicalized intent.
// Admin-only.  GET → dry-run (counts + samples).  GET ?apply=1 → write.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getDb, isDbConfigured } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEADS = "domain_research_leads";

// Same canonicalizer as createDeal's normIntent (kept in sync). "ac?quir" catches the
// common misspelling "Aquire a domain" as well as "Acquire".
function normIntent(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (/sell|selling/.test(l)) return "Sell";
  if (/ac?quir|buy|buying|purchas/.test(l)) return "Acquire";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type DealRow = { id: string; domain: string; buyer_email: string | null; lead_key: string | null; intent: string | null };
type LeadRow = { lead_key: string | null; email: string | null; intent: string | null };

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!isDbConfigured()) return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  const apply = new URL(req.url).searchParams.get("apply") === "1";

  const { data: dealData, error: dealErr } = await getDb().from("deals").select("id,domain,buyer_email,lead_key,intent");
  if (dealErr) return NextResponse.json({ error: `deals: ${dealErr.message}` }, { status: 500 });
  const deals = (dealData as DealRow[]) || [];

  // Pass A — re-canonicalize existing non-canonical values (e.g. "Aquire a domain" → "Acquire").
  const recanon: { id: string; domain: string; from: string; to: string }[] = [];
  for (const d of deals) {
    if (!d.intent) continue;
    const canon = normIntent(d.intent);
    if (canon && canon !== d.intent) recanon.push({ id: d.id, domain: d.domain, from: d.intent, to: canon });
  }

  // Pass B — fill nulls from the lead form (by lead_key, then buyer email).
  const { data: leadData, error: leadErr } = await getDb().from(LEADS).select("lead_key,email,intent").not("intent", "is", null);
  if (leadErr) return NextResponse.json({ error: `leads: ${leadErr.message}` }, { status: 500 });
  const byKey = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const l of (leadData as LeadRow[]) || []) {
    const ci = normIntent(l.intent);
    if (!ci) continue;
    if (l.lead_key && !byKey.has(l.lead_key)) byKey.set(l.lead_key, ci);
    const em = (l.email || "").trim().toLowerCase();
    if (em && !byEmail.has(em)) byEmail.set(em, ci);
  }
  const fills: { id: string; domain: string; intent: string; via: "lead_key" | "email" }[] = [];
  for (const d of deals) {
    if (d.intent) continue;
    let hit = d.lead_key ? byKey.get(d.lead_key) : undefined;
    let via: "lead_key" | "email" = "lead_key";
    if (!hit && d.buyer_email) { hit = byEmail.get(String(d.buyer_email).trim().toLowerCase()); via = "email"; }
    if (hit) fills.push({ id: d.id, domain: d.domain, intent: hit, via });
  }

  let recanonUpdated = 0, filled = 0;
  const errors: string[] = [];
  if (apply) {
    for (const r of recanon) {
      const res = await getDb().from("deals").update({ intent: r.to }).eq("id", r.id);
      if (res.error) errors.push(`${r.domain}: ${res.error.message}`); else recanonUpdated += 1;
    }
    for (const m of fills) {
      const res = await getDb().from("deals").update({ intent: m.intent }).eq("id", m.id).is("intent", null);
      if (res.error) errors.push(`${m.domain}: ${res.error.message}`); else filled += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    apply,
    dealsTotal: deals.length,
    recanonicalize: recanon.length,     // existing values needing a clean rewrite (e.g. "Aquire a domain")
    recanonUpdated,
    fillNullsFromLeads: fills.length,    // null-intent deals matched to a lead
    filled,
    leadsWithIntent: (leadData as LeadRow[] | null)?.length || 0,
    errors: errors.slice(0, 10),
    recanonSample: recanon.slice(0, 15),
    fillSample: fills.slice(0, 15),
    note: apply ? "Applied." : "Dry run — re-call with ?apply=1 to write.",
  });
}
