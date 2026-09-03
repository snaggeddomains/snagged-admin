// One-time backfill: fill deals.intent ("Acquire or Sell?") on EXISTING deals from the
// inquiry form. The answer is stored on domain_research_leads.intent — match a deal to its
// lead by lead_key first, else by buyer email, canonicalize to "Acquire"/"Sell", and write
// where the deal's intent is still null. Admin-only.
//   GET                → dry-run (counts + a sample of what WOULD be written)
//   GET ?apply=1       → write intent on the matched deals (only where currently null)

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getDb, isDbConfigured } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const LEADS = "domain_research_leads";

// Same canonicalizer as createDeal's normIntent (kept in sync).
function normIntent(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const l = s.toLowerCase();
  if (/\bsell|selling\b/.test(l)) return "Sell";
  if (/\bacquir|buy|buying|purchas/.test(l)) return "Acquire";
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

  // Deals that still need intent (select intent so pre-migration DBs surface a clear error).
  const { data: dealData, error: dealErr } = await getDb().from("deals")
    .select("id,domain,buyer_email,lead_key,intent");
  if (dealErr) return NextResponse.json({ error: `deals: ${dealErr.message}` }, { status: 500 });
  const todo = ((dealData as DealRow[]) || []).filter((d) => !d.intent && (d.lead_key || d.buyer_email));

  // Pull leads with an intent, index by lead_key + email.
  const { data: leadData, error: leadErr } = await getDb().from(LEADS)
    .select("lead_key,email,intent").not("intent", "is", null);
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

  const matches: { id: string; domain: string; intent: string; via: "lead_key" | "email" }[] = [];
  for (const d of todo) {
    let hit = d.lead_key ? byKey.get(d.lead_key) : undefined;
    let via: "lead_key" | "email" = "lead_key";
    if (!hit && d.buyer_email) { hit = byEmail.get(String(d.buyer_email).trim().toLowerCase()); via = "email"; }
    if (hit) matches.push({ id: d.id, domain: d.domain, intent: hit, via });
  }

  let updated = 0;
  const errors: string[] = [];
  if (apply) {
    for (const m of matches) {
      const r = await getDb().from("deals").update({ intent: m.intent }).eq("id", m.id).is("intent", null);
      if (r.error) errors.push(`${m.domain}: ${r.error.message}`);
      else updated += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    apply,
    dealsMissingIntent: todo.length,
    leadsWithIntent: (leadData as LeadRow[] | null)?.length || 0,
    matched: matches.length,
    updated,
    errors: errors.slice(0, 10),
    sample: matches.slice(0, 25),
    note: apply ? "Applied." : "Dry run — re-call with ?apply=1 to write.",
  });
}
