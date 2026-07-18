// Persistence for the social sweep (Reddit + X) — social_sweep_posts + social_sweep_runs
// in the MAIN admin project via getDb(). Only high-signal/maybe posts are stored (the
// ignore bucket is discarded). Deduped by post id so a post alerts once. The table is
// PLATFORM-tagged so the X sweep writes to the same store + Reports tab.

import { getDb, isDbConfigured } from "../supabase";

const TABLE = "social_sweep_posts";
const RUNS = "social_sweep_runs";
const PAGE = 1000;

export type SweepPost = {
  id: string; // `${platform}:${link}`
  platform: "reddit" | "x";
  source: string; // subreddit (reddit) or query/handle (x)
  title: string;
  link: string;
  author: string | null;
  published: string | null;
  score: number;
  bucket: "high-signal" | "maybe";
  buy_side: boolean;
  sell_side: boolean;
  matched: string[];
  sample: string;
  snippet: string;
};

// Strip NUL + C0 control chars (Reddit RSS decodes &#0;-style entities that Postgres
// rejects as "invalid input syntax for type json"). Keep tab/newline/CR.
function clean(s: string | null): string | null {
  if (s == null) return null;
  let out = "";
  for (const ch of String(s)) {
    const n = ch.codePointAt(0) || 0;
    if (n < 32 && n !== 9 && n !== 10 && n !== 13) continue;
    if (n === 0xfffe || n === 0xffff) continue;
    out += ch;
  }
  return out;
}

/** Every post id already stored (net-new detection for the digest). */
async function existingIds(platform: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (!isDbConfigured()) return set;
  const db = getDb();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(TABLE).select("id").eq("platform", platform).range(from, from + PAGE - 1);
    if (error) break; // table absent → treat everything as new (degrade gracefully)
    const rows = data ?? [];
    for (const r of rows) set.add(String((r as { id?: unknown }).id || ""));
    if (rows.length < PAGE) break;
  }
  return set;
}

/**
 * Upsert the scored posts; returns the ids that are NEW this run (for the digest).
 * `dismissed` + `first_seen_at` are omitted so they're preserved on conflict.
 */
export async function upsertPosts(posts: SweepPost[]): Promise<{ written: number; newIds: Set<string> }> {
  const newIds = new Set<string>();
  if (!isDbConfigured() || !posts.length) return { written: 0, newIds };
  const db = getDb();
  const platform = posts[0].platform;
  const existing = await existingIds(platform);
  for (const p of posts) if (!existing.has(p.id)) newIds.add(p.id);

  const now = new Date().toISOString();
  const rows = posts.map((p) => ({
    id: p.id, platform: p.platform, source: clean(p.source), title: clean(p.title), link: p.link,
    author: clean(p.author), published: p.published, score: p.score, bucket: p.bucket,
    buy_side: p.buy_side, sell_side: p.sell_side, matched: p.matched.map((m) => clean(m) || "").filter(Boolean),
    sample: clean(p.sample), snippet: clean(p.snippet), last_seen_at: now.slice(0, 10),
  }));
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await db.from(TABLE).upsert(chunk, { onConflict: "id" });
    if (error) throw new Error(`sweep upsert: ${error.message || error.code || "failed"}`);
    written += chunk.length;
  }
  return { written, newIds };
}

export type SweepListRow = SweepPost & { dismissed: boolean; first_seen_at: string };

/** Posts for the Reports tab (newest first, high-signal before maybe). Paginated. */
export async function listPosts(opts: { platform?: string; includeDismissed?: boolean; includeMaybe?: boolean } = {}): Promise<SweepListRow[]> {
  if (!isDbConfigured()) return [];
  const db = getDb();
  const out: SweepListRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = db
      .from(TABLE)
      .select("id,platform,source,title,link,author,published,score,bucket,buy_side,sell_side,matched,sample,snippet,dismissed,first_seen_at")
      .order("first_seen_at", { ascending: false })
      .order("score", { ascending: false })
      .range(from, from + PAGE - 1);
    if (opts.platform) q = q.eq("platform", opts.platform);
    if (!opts.includeDismissed) q = q.eq("dismissed", false);
    if (!opts.includeMaybe) q = q.eq("bucket", "high-signal");
    const { data, error } = await q;
    if (error) break;
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of rows) {
      out.push({
        id: String(row.id), platform: (row.platform === "x" ? "x" : "reddit"),
        source: String(row.source || ""), title: String(row.title || ""), link: String(row.link || ""),
        author: row.author != null ? String(row.author) : null,
        published: row.published != null ? String(row.published) : null,
        score: typeof row.score === "number" ? row.score : Number(row.score) || 0,
        bucket: row.bucket === "maybe" ? "maybe" : "high-signal",
        buy_side: Boolean(row.buy_side), sell_side: Boolean(row.sell_side),
        matched: Array.isArray(row.matched) ? (row.matched as string[]) : [],
        sample: String(row.sample || ""), snippet: String(row.snippet || ""),
        dismissed: Boolean(row.dismissed),
        first_seen_at: row.first_seen_at ? String(row.first_seen_at).slice(0, 10) : "",
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

/** Dismiss / restore one post. */
export async function setPostDismissed(id: string, dismissed: boolean): Promise<boolean> {
  if (!isDbConfigured() || !id) return false;
  const { error } = await getDb().from(TABLE).update({ dismissed }).eq("id", id);
  return !error;
}

export type SweepRun = {
  run_at: string; platform: string; fetched: number; scored: number;
  high: number; maybe: number; new_count: number; feed_errors: string[];
  ok: boolean; error: string | null;
};

export async function logSweepRun(run: Omit<SweepRun, "run_at">): Promise<void> {
  if (!isDbConfigured()) return;
  try { await getDb().from(RUNS).insert({ ...run, run_at: new Date().toISOString() }); } catch { /* best-effort */ }
}

export async function recentSweepRuns(limit = 20): Promise<SweepRun[]> {
  if (!isDbConfigured()) return [];
  const { data, error } = await getDb().from(RUNS)
    .select("run_at,platform,fetched,scored,high,maybe,new_count,feed_errors,ok,error")
    .order("run_at", { ascending: false }).limit(limit);
  if (error) return [];
  return (data ?? []) as SweepRun[];
}
