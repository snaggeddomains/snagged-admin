// SEO report storage: curated target keywords, weekly GSC snapshots (for
// week-over-week position deltas = "gaining/losing distance"), and the action loop.
// All reads fail-open to empty so the report renders before scripts/seo.sql is run.
import { getDb, isDbConfigured } from "../supabase";

export type TargetKeyword = {
  id: string; keyword: string; target_url: string | null; intent: string | null;
  priority: number; volume: number | null; notes: string | null; active: boolean;
};
export type Snapshot = {
  week_start: string; scope: string; keyword: string; position: number | null;
  impressions: number; clicks: number; ctr: number | null; volume: number | null;
  ahrefs_position: number | null; competitor_position: number | null; top_url: string | null;
};
export type SeoAction = {
  id: string; title: string; detail: string | null; playbook: string | null; keyword: string | null; target_url: string | null;
  status: string; priority: number; owner_email: string | null; created_by: string | null;
  created_at: string; updated_at: string; done_at: string | null;
};

// Monday (UTC) of the week containing `d` — the canonical snapshot week_start.
export function weekStart(d: Date = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay(); // 0=Sun
  t.setUTCDate(t.getUTCDate() - ((dow + 6) % 7));
  return t.toISOString().slice(0, 10);
}
export function priorWeek(week: string): string {
  const d = new Date(week + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

export async function listTargets(): Promise<TargetKeyword[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from("seo_target_keywords").select("*").eq("active", true).order("priority").order("keyword");
    return (data as TargetKeyword[]) || [];
  } catch { return []; }
}

export async function upsertTarget(t: Partial<TargetKeyword> & { keyword: string }): Promise<void> {
  if (!isDbConfigured()) return;
  const row: Record<string, unknown> = { keyword: t.keyword.trim(), target_url: t.target_url ?? null, intent: t.intent ?? null, priority: t.priority ?? 2, notes: t.notes ?? null, updated_at: new Date().toISOString() };
  if (t.active !== undefined) row.active = t.active;
  if (t.id) { await getDb().from("seo_target_keywords").update(row).eq("id", t.id); return; }
  await getDb().from("seo_target_keywords").upsert(row, { onConflict: "keyword" });
}

export async function deactivateTarget(id: string): Promise<void> {
  if (!isDbConfigured()) return;
  try { await getDb().from("seo_target_keywords").update({ active: false, updated_at: new Date().toISOString() }).eq("id", id); } catch { /* noop */ }
}

// Upsert a week's snapshot rows for one scope (idempotent per week+scope+keyword).
export async function writeSnapshots(week: string, scope: string, rows: Omit<Snapshot, "week_start" | "scope">[]): Promise<number> {
  if (!isDbConfigured() || !rows.length) return 0;
  const payload = rows.map((r) => ({ week_start: week, scope, ...r }));
  try { await getDb().from("seo_keyword_snapshots").upsert(payload, { onConflict: "week_start,scope,keyword" }); return payload.length; } catch { return 0; }
}

export async function snapshotsForWeek(week: string, scope: string): Promise<Snapshot[]> {
  if (!isDbConfigured()) return [];
  try { const { data } = await getDb().from("seo_keyword_snapshots").select("*").eq("scope", scope).eq("week_start", week); return (data as Snapshot[]) || []; } catch { return []; }
}

// Distinct snapshot weeks for a scope, newest first.
export async function snapshotWeeks(scope: string, limit = 12): Promise<string[]> {
  if (!isDbConfigured()) return [];
  try {
    const { data } = await getDb().from("seo_keyword_snapshots").select("week_start").eq("scope", scope).order("week_start", { ascending: false }).limit(2000);
    const seen = new Set<string>(); const out: string[] = [];
    for (const r of (data as { week_start: string }[]) || []) { if (!seen.has(r.week_start)) { seen.add(r.week_start); out.push(r.week_start); } if (out.length >= limit) break; }
    return out;
  } catch { return []; }
}

export async function listActions(includeDone = true): Promise<SeoAction[]> {
  if (!isDbConfigured()) return [];
  try {
    let q = getDb().from("seo_actions").select("*").order("status").order("priority").order("updated_at", { ascending: false });
    if (!includeDone) q = q.neq("status", "done");
    const { data } = await q;
    return (data as SeoAction[]) || [];
  } catch { return []; }
}

export async function upsertAction(a: Partial<SeoAction> & { title?: string }, actor?: string): Promise<SeoAction | null> {
  if (!isDbConfigured()) return null;
  const now = new Date().toISOString();
  if (a.id) {
    const row: Record<string, unknown> = { updated_at: now };
    for (const k of ["title", "detail", "playbook", "keyword", "target_url", "status", "priority", "owner_email"] as const) if (a[k] !== undefined) row[k] = a[k];
    if (a.status === "done") row.done_at = now;
    if (a.status && a.status !== "done") row.done_at = null;
    try { await getDb().from("seo_actions").update(row).eq("id", a.id); } catch { /* noop */ }
    return null;
  }
  try {
    const { data } = await getDb().from("seo_actions").insert({
      title: a.title || "Untitled", detail: a.detail ?? null, keyword: a.keyword ?? null, target_url: a.target_url ?? null,
      status: a.status || "todo", priority: a.priority ?? 2, owner_email: a.owner_email ?? null, created_by: actor ?? null,
      created_at: now, updated_at: now,
    }).select("*").single();
    return (data as SeoAction) || null;
  } catch { return null; }
}
