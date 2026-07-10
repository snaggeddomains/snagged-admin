// Archive overlay for the SNAP Names report — a per-domain "hide from the list"
// flag the team maintains by hand (a name we no longer want cluttering the view).
// Shared + persistent (Supabase, admin project). Server-only. Fail-open: if the
// table doesn't exist yet, nothing is archived and the report still works.
//
// One-time migration (admin project — SUPABASE_URL / SERVICE_ROLE_KEY):
//   create table if not exists snap_names_archive (
//     domain text primary key,
//     archived_by text,
//     archived_at timestamptz not null default now()
//   );
//   alter table snap_names_archive enable row level security; -- service key bypasses

import { getDb, isDbConfigured } from "./supabase";

const TABLE = "snap_names_archive";

// The set of archived domains (lowercased). Best-effort → empty on any failure.
export async function listArchived(): Promise<string[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from(TABLE).select("domain");
    return (data || []).map((r: { domain: string }) => String(r.domain || "").toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

// Archive (true) or un-archive (false) one domain. Throws on a genuine write
// failure so the UI can surface a clear "run the migration" message.
export async function setArchived(domain: string, archived: boolean, by: string | null): Promise<void> {
  if (!isDbConfigured()) throw new Error("Archive storage isn't configured (Supabase).");
  const d = String(domain || "").trim().toLowerCase();
  if (!d) throw new Error("No domain.");
  const db = getDb();
  const { error } = archived
    ? await db.from(TABLE).upsert({ domain: d, archived_by: by, archived_at: new Date().toISOString() }, { onConflict: "domain" })
    : await db.from(TABLE).delete().eq("domain", d);
  if (error) {
    if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message)) {
      throw new Error("Archive table isn't ready — run the snap_names_archive migration on the admin project, then `NOTIFY pgrst, 'reload schema';`.");
    }
    throw new Error(error.message);
  }
}
