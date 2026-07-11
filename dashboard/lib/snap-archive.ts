// Archive overlay for the SNAP Names report — a per-domain "hide from the list"
// flag the team maintains by hand (a name we no longer want cluttering the view).
// Shared + persistent (Supabase, admin project). Server-only. Fail-open: if the
// table doesn't exist yet, nothing is archived and the report still works.
//
// One-time migration (admin project — SUPABASE_URL / SERVICE_ROLE_KEY):
//   create table if not exists snap_names_archive (
//     domain text primary key,
//     tag text,                 -- reason for archiving (Sold / Let expire / …)
//     archived_by text,
//     archived_at timestamptz not null default now()
//   );
//   alter table snap_names_archive add column if not exists tag text; -- if pre-existed
//   alter table snap_names_archive enable row level security; -- service key bypasses

import { getDb, isDbConfigured } from "./supabase";

const TABLE = "snap_names_archive";

export interface ArchivedRow { domain: string; tag: string | null }

// Archived domains + their reason tag (lowercased domain). Best-effort → [] on failure.
// Falls back to domain-only select if the `tag` column hasn't been added yet.
export async function listArchived(): Promise<ArchivedRow[]> {
  if (!isDbConfigured()) return [];
  try {
    const withTag = await getDb().from(TABLE).select("domain, tag");
    const res = withTag.error ? await getDb().from(TABLE).select("domain") : withTag;
    return (res.data || [])
      .map((r: { domain?: string; tag?: string | null }) => ({ domain: String(r.domain || "").toLowerCase(), tag: r.tag ?? null }))
      .filter((r: ArchivedRow) => r.domain);
  } catch {
    return [];
  }
}

// Archive (true, with an optional reason tag) or un-archive (false) one domain. Throws
// on a genuine write failure so the UI can surface a clear "run the migration" message.
export async function setArchived(domain: string, archived: boolean, by: string | null, tag?: string | null): Promise<void> {
  if (!isDbConfigured()) throw new Error("Archive storage isn't configured (Supabase).");
  const d = String(domain || "").trim().toLowerCase();
  if (!d) throw new Error("No domain.");
  const db = getDb();
  if (!archived) {
    const { error } = await db.from(TABLE).delete().eq("domain", d);
    if (error) throwArchive(error);
    return;
  }
  const row: Record<string, unknown> = { domain: d, tag: (tag || "").trim() || null, archived_by: by, archived_at: new Date().toISOString() };
  let { error } = await db.from(TABLE).upsert(row, { onConflict: "domain" });
  // Degrade gracefully if the tag column hasn't been added yet.
  if (error && (/tag/i.test(error.message) || error.code === "42703" || /schema cache|PGRST204/i.test(error.message))) {
    delete row.tag;
    ({ error } = await db.from(TABLE).upsert(row, { onConflict: "domain" }));
  }
  if (error) throwArchive(error);
}

function throwArchive(error: { code?: string; message: string }): never {
  if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message)) {
    throw new Error("Archive table isn't ready — run the snap_names_archive migration on the admin project, then `NOTIFY pgrst, 'reload schema';`.");
  }
  throw new Error(error.message);
}
