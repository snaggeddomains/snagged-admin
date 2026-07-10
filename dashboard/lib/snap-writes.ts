// Audit log for SNAP Names registrar writes — every attempted nameserver / DNS
// change, whether it succeeded, and who did it. Server-only, best-effort (a logging
// failure never blocks or reverses a write, but we try hard to record).
//
// One-time migration (admin project — SUPABASE_URL / SERVICE_ROLE_KEY):
//   create table if not exists snap_names_writes (
//     id bigint generated always as identity primary key,
//     domain text not null,
//     provider text,
//     account text,
//     action text not null,          -- 'nameservers' | 'dns'
//     from_ns text[],
//     to_ns text[],
//     record jsonb,
//     ok boolean not null,
//     error text,
//     changed_by text,
//     created_at timestamptz not null default now()
//   );
//   alter table snap_names_writes enable row level security; -- service key bypasses

import { getDb, isDbConfigured } from "./supabase";

export interface WriteLog {
  domain: string;
  provider: string | null;
  account?: string | null;
  action: "nameservers" | "dns";
  from_ns?: string[] | null;
  to_ns?: string[] | null;
  record?: unknown;
  ok: boolean;
  error?: string | null;
  changed_by?: string | null;
}

export async function logWrite(entry: WriteLog): Promise<void> {
  if (!isDbConfigured()) return;
  try {
    await getDb().from("snap_names_writes").insert({
      domain: entry.domain,
      provider: entry.provider,
      account: entry.account ?? null,
      action: entry.action,
      from_ns: entry.from_ns ?? null,
      to_ns: entry.to_ns ?? null,
      record: entry.record ?? null,
      ok: entry.ok,
      error: entry.error ?? null,
      changed_by: entry.changed_by ?? null,
    });
  } catch {
    /* audit table may not exist yet — never block the write on logging */
  }
}

export async function recentWrites(limit = 100): Promise<WriteLog[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from("snap_names_writes").select("*").order("created_at", { ascending: false }).limit(limit);
    return (data || []) as WriteLog[];
  } catch {
    return [];
  }
}
