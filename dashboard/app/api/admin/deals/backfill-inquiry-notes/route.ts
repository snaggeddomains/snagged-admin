// One-time backfill: fill deals.notes with the buyer's original inquiry MESSAGE (+ location) on
// EXISTING inquiry-sourced deals whose Notes are blank. The message is stored on the lead record
// (domain_research_leads.form.message), matched to the deal by lead_key, falling back to buyer email.
// Only writes where notes is currently empty — never overwrites a note someone already typed.
//   GET            → dry-run (counts + a sample of what WOULD be written)
//   GET ?apply=1   → write notes on the matched deals

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getDb, isDbConfigured } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type DealRow = { id: string; domain: string; lead_key: string | null; buyer_email: string | null; notes: string | null };
type LeadRow = { lead_key: string; email: string | null; form: Record<string, unknown> | null };

const s = (v: unknown) => (v == null ? "" : String(v).trim());
function notesFromForm(form: Record<string, unknown> | null): string {
  const f = form || {};
  const msg = s(f.message) || s((f as Record<string, unknown>).Message);
  const loc = s(f.location) || s((f as Record<string, unknown>).Location);
  if (!msg && !loc) return "";
  return [msg ? `📩 Buyer's inquiry:\n${msg}` : "", loc ? `Location: ${loc}` : ""].filter(Boolean).join("\n\n");
}

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!me.is_admin) return NextResponse.json({ error: "Admin only" }, { status: 403 });
  if (!isDbConfigured()) return NextResponse.json({ error: "DB not configured" }, { status: 500 });
  const apply = new URL(req.url).searchParams.get("apply") === "1";

  // Deals with blank notes that could have come from an inquiry (have a lead_key or a buyer email).
  const { data, error } = await getDb().from("deals").select("id,domain,lead_key,buyer_email,notes");
  if (error) return NextResponse.json({ error: `deals: ${error.message}` }, { status: 500 });
  const todo = ((data as DealRow[]) || []).filter((d) => !s(d.notes) && (d.lead_key || d.buyer_email));

  const leadKeys = [...new Set(todo.map((d) => d.lead_key).filter(Boolean) as string[])];
  const emails = [...new Set(todo.map((d) => s(d.buyer_email).toLowerCase()).filter(Boolean))];

  // Pull the matching leads (by key + by email), build lookup maps of assembled notes.
  const byKey = new Map<string, string>();
  const byEmail = new Map<string, string>();
  const [keyRes, emailRes] = await Promise.all([
    leadKeys.length ? getDb().from("domain_research_leads").select("lead_key,email,form").in("lead_key", leadKeys) : Promise.resolve({ data: [] as LeadRow[] }),
    emails.length ? getDb().from("domain_research_leads").select("lead_key,email,form").in("email", emails) : Promise.resolve({ data: [] as LeadRow[] }),
  ]);
  for (const l of (keyRes.data as LeadRow[] | null) || []) { const n = notesFromForm(l.form); if (n && l.lead_key) byKey.set(l.lead_key, n); }
  for (const l of (emailRes.data as LeadRow[] | null) || []) { const n = notesFromForm(l.form); const em = s(l.email).toLowerCase(); if (n && em && !byEmail.has(em)) byEmail.set(em, n); }

  const matches: { id: string; domain: string; via: string; notes: string }[] = [];
  for (const d of todo) {
    const n = (d.lead_key && byKey.get(d.lead_key)) || byEmail.get(s(d.buyer_email).toLowerCase());
    if (n) matches.push({ id: d.id, domain: d.domain, via: d.lead_key && byKey.get(d.lead_key) ? "lead_key" : "email", notes: n });
  }

  let updated = 0;
  const errors: string[] = [];
  if (apply) {
    for (const m of matches) {
      const r = await getDb().from("deals").update({ notes: m.notes }).eq("id", m.id).or("notes.is.null,notes.eq.");
      if (r.error) errors.push(`${m.domain}: ${r.error.message}`);
      else updated += 1;
    }
  }

  return NextResponse.json({
    ok: true, apply,
    dealsBlankNotes: todo.length,
    matched: matches.length,
    updated,
    errors: errors.slice(0, 10),
    sample: matches.slice(0, 20).map((m) => ({ domain: m.domain, via: m.via, preview: m.notes.slice(0, 160) })),
    note: apply ? "Applied." : "Dry run — re-call with ?apply=1 to write.",
  });
}
