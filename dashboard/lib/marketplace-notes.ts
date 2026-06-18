// Per-domain broker notes for the Marketplace deal report. Free-text the broker
// maintains by hand — off-platform activity that never lands in Gmail/HubSpot
// (offers over text/WhatsApp/phone, verbal context, next steps). Saved from the
// admin report and folded into the generated client Doc. Server-only.
//
// One-time migration (admin project — SUPABASE_URL / SERVICE_ROLE_KEY):
//   create table if not exists marketplace_deal_notes (
//     domain text primary key,
//     notes text not null default '',
//     updated_at timestamptz not null default now(),
//     updated_by text
//   );
//   alter table marketplace_deal_notes enable row level security; -- service key bypasses

import { getDb, isDbConfigured } from "./supabase";

const TABLE = "marketplace_deal_notes";
const MAX_LEN = 20000; // generous; a few paragraphs of context, not a document

export type DealNotes = { notes: string; updatedAt: string | null; updatedBy: string | null };

const EMPTY: DealNotes = { notes: "", updatedAt: null, updatedBy: null };

// Best-effort read. Returns empty notes when the table doesn't exist yet or the
// DB isn't configured — the report still works, just without notes.
export async function getNotes(domain: string): Promise<DealNotes> {
  if (!isDbConfigured()) return EMPTY;
  try {
    const { data } = await getDb().from(TABLE).select("notes,updated_at,updated_by").eq("domain", domain).maybeSingle();
    if (!data) return EMPTY;
    return { notes: data.notes || "", updatedAt: data.updated_at || null, updatedBy: data.updated_by || null };
  } catch {
    return EMPTY; // table may not exist — treat as no notes
  }
}

// Upsert the notes for a domain. Returns the stored row (with the fresh
// updated_at). Throws only on a genuine write failure so the UI can surface it.
export async function saveNotes(domain: string, notes: string, updatedBy: string | null): Promise<DealNotes> {
  if (!isDbConfigured()) throw new Error("Notes storage isn't configured (Supabase).");
  const clean = (notes || "").slice(0, MAX_LEN);
  const updatedAt = new Date().toISOString();
  const { error } = await getDb()
    .from(TABLE)
    .upsert({ domain, notes: clean, updated_at: updatedAt, updated_by: updatedBy }, { onConflict: "domain" });
  if (error) {
    // 42P01 = undefined_table — the one-time migration hasn't been run yet.
    if (error.code === "42P01" || /does not exist/i.test(error.message)) {
      throw new Error("Notes table not set up yet — run scripts/marketplace_deal_notes.sql on the admin Supabase project.");
    }
    throw new Error(error.message);
  }
  return { notes: clean, updatedAt, updatedBy };
}
