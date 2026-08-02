// One-time backfill: fill deals.heard_about ("How did you hear about us?") on EXISTING deals.
// The attribution isn't stored on old deals or old leads (readForm only started capturing it
// on 2026-08-02) — it only lives in the actual contact-form submissions, which leadsReport()
// parses (Lead.source). Match a deal to its submission by buyer email. Admin-only.
//   GET                → dry-run (counts + a sample of what WOULD be written)
//   GET ?apply=1       → write heard_about on the matched deals (only where currently null)

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getDb, isDbConfigured } from "@/lib/supabase";
import { leadsReport, canonicalSource } from "@/lib/leads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DealRow = { id: string; domain: string; buyer_email: string | null; heard_about: string | null };

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!isDbConfigured()) return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  const apply = new URL(req.url).searchParams.get("apply") === "1";

  // Deals that still need the attribution and have a buyer email to match on.
  const { data, error } = await getDb().from("deals")
    .select("id,domain,buyer_email,heard_about")
    .not("buyer_email", "is", null);
  if (error) return NextResponse.json({ error: `deals: ${error.message}` }, { status: 500 });
  const todo = ((data as DealRow[]) || []).filter((d) => d.buyer_email && !d.heard_about);

  // Parse ~3 years of contact-form submissions → email → the "How did you hear about us?" value.
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const rep = await leadsReport(day(Date.now() - 3 * 365 * 86_400_000), day(Date.now()));
  const byEmail = new Map<string, string>();
  for (const l of rep.leads) {
    const em = (l.email || "").trim().toLowerCase();
    const src = canonicalSource(l.source);
    if (em && src && src !== "(unknown)" && !byEmail.has(em)) byEmail.set(em, src);
  }

  const matches: { id: string; domain: string; email: string; heard_about: string }[] = [];
  for (const d of todo) {
    const em = String(d.buyer_email).trim().toLowerCase();
    const src = byEmail.get(em);
    if (src) matches.push({ id: d.id, domain: d.domain, email: em, heard_about: src });
  }

  let updated = 0;
  const errors: string[] = [];
  if (apply) {
    for (const m of matches) {
      const r = await getDb().from("deals").update({ heard_about: m.heard_about }).eq("id", m.id).is("heard_about", null);
      if (r.error) errors.push(`${m.domain}: ${r.error.message}`);
      else updated += 1;
    }
  }

  return NextResponse.json({
    ok: true,
    apply,
    dealsMissingAttribution: todo.length,
    submissionsParsed: rep.leads.length,
    emailsWithAttribution: byEmail.size,
    matched: matches.length,
    updated,
    errors: errors.slice(0, 10),
    sample: matches.slice(0, 25),
    note: apply ? "Applied." : "Dry run — re-call with ?apply=1 to write.",
  });
}
