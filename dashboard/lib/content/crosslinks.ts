// Content cross-linking engine — reads every blog post from the Webflow CMS and produces a
// stack-ranked list of the best INTERNAL-LINK opportunities (source post → target post) for SEO.
// Two stages: (1) deterministic candidate generation (tf-idf term overlap) shortlists likely
// targets per post; (2) an LLM pass confirms genuine relevance, picks the exact anchor phrase in
// the source, scores it, and explains why. Persistent 👍/👎 feedback (per source→target pair)
// trains future runs: down-voted pairs are suppressed + fed to the LLM as "avoid", up-voted
// pairs are boosted. Server-only.

import { getDb, isDbConfigured } from "../supabase";
import { webflowConfigured, loadCollectionResolved, type WfField, type WfItem } from "../webflow";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.CONTENT_CROSSLINK_MODEL || "claude-haiku-4-5-20251001";
const CANDIDATES_PER_POST = 8;   // shortlist size fed to the LLM
const MAX_OPPS_PER_POST = 4;     // cap so one post doesn't flood the list
const BODY_CHARS = 3800;         // source-body budget per LLM call
const CONCURRENCY = 6;

export function crosslinksConfigured(): boolean {
  return isDbConfigured() && webflowConfigured() && Boolean(process.env.ANTHROPIC_API_KEY) && Boolean(process.env.WEBFLOW_BLOG_POSTS_ID);
}

// ---------- text utils ----------
const STOP = new Set("the a an and or but for nor so yet of to in on at by with from as is are was were be been being this that these those it its it's you your we our they their he she his her them us i me my mine also can will just how what why when where which who whom your yours about into over under more most some any all no not only than then them too very s t re ve ll d m o re com co io net org domain domains name names post posts blog".split(/\s+/));
const stripHtml = (s: string): string => String(s || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w));
}

export type Post = { id: string; title: string; slug: string; summary: string; text: string; linkedSlugs: Set<string>; isDraft: boolean };

// Detect the title / slug / summary / body fields, then map items → Post.
function toPosts(fields: WfField[], items: WfItem[]): Post[] {
  const bySlug = (re: RegExp) => fields.find((f) => re.test(f.slug) || re.test(f.displayName || ""))?.slug;
  const titleSlug = fields.find((f) => f.slug === "name")?.slug || bySlug(/title|name/i) || "name";
  const urlSlug = fields.find((f) => f.slug === "slug")?.slug || "slug";
  const summarySlug = bySlug(/summary|excerpt|subtitle/i);
  // Body = the RichText field with the most content (excluding the summary field).
  const richFields = fields.filter((f) => /richtext/i.test(f.type) && f.slug !== summarySlug);
  let bodySlug = bySlug(/post.?body|^body$|content|article/i);
  if (!bodySlug && richFields.length) {
    let best = -1;
    for (const f of richFields) {
      const total = items.reduce((n, it) => n + String(it.fieldData[f.slug] || "").length, 0);
      if (total > best) { best = total; bodySlug = f.slug; }
    }
  }
  return items.map((it) => {
    const bodyHtml = String((bodySlug && it.fieldData[bodySlug]) || "");
    const linkedSlugs = new Set<string>();
    for (const m of bodyHtml.matchAll(/href=["'][^"']*\/post\/([a-z0-9-]+)/gi)) linkedSlugs.add(m[1].toLowerCase());
    return {
      id: it.id,
      title: stripHtml(String(it.fieldData[titleSlug] || "")) || "(untitled)",
      slug: String(it.fieldData[urlSlug] || "").trim(),
      summary: summarySlug ? stripHtml(String(it.fieldData[summarySlug] || "")) : "",
      text: stripHtml(bodyHtml),
      linkedSlugs,
      isDraft: !!it.isDraft,
    };
  }).filter((p) => p.text.length > 60);
}

// ---------- candidate generation (tf-idf overlap) ----------
type Vec = Map<string, number>;
function buildVectors(posts: Post[]): Vec[] {
  const df = new Map<string, number>();
  const tfs: Vec[] = posts.map((p) => {
    const tf = new Map<string, number>();
    for (const w of tokens(`${p.title} ${p.title} ${p.summary} ${p.text}`)) tf.set(w, (tf.get(w) || 0) + 1);
    for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    return tf;
  });
  const N = posts.length;
  return tfs.map((tf) => {
    const v: Vec = new Map();
    let norm = 0;
    for (const [w, c] of tf) { const idf = Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1; const wt = (1 + Math.log(c)) * idf; v.set(w, wt); norm += wt * wt; }
    norm = Math.sqrt(norm) || 1;
    for (const [w, wt] of v) v.set(w, wt / norm);
    return v;
  });
}
function sim(a: Vec, b: Vec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [w, wt] of small) { const o = big.get(w); if (o) s += wt * o; }
  return s;
}

// ---------- LLM pass ----------
type RawOpp = { target: number; anchor: string; context?: string; score: number; reason?: string };
async function llmOpps(source: Post, candidates: Post[], avoidTitles: string[], preferTitles: string[]): Promise<RawOpp[]> {
  const key = process.env.ANTHROPIC_API_KEY!;
  const list = candidates.map((c, i) => `[${i}] ${c.title}${c.summary ? ` — ${c.summary.slice(0, 160)}` : ""}`).join("\n");
  const system =
    `You improve SEO by finding INTERNAL cross-link opportunities between blog posts on snagged.com (a domain marketplace/blog). ` +
    `Given the SOURCE post and a list of CANDIDATE posts, find where the source post should link to a candidate — but ONLY when it is HIGHLY, SPECIFICALLY relevant (a reader clicking the link gets a genuinely related, useful next read). Reject loose/topical-only matches. ` +
    `For each opportunity return: "target" (candidate index), "anchor" (a short phrase COPIED VERBATIM from the SOURCE post body to turn into the link — 2-6 words, must appear exactly in the text), "context" (the sentence it's in), "score" (0-100 relevance), "reason" (one short line). ` +
    `Return AT MOST ${MAX_OPPS_PER_POST}, best first. Return STRICT JSON: [{"target":0,"anchor":"","context":"","score":0,"reason":""}]. Empty array if nothing is strongly relevant. ` +
    (avoidTitles.length ? `Do NOT suggest these targets (previously judged NOT relevant): ${avoidTitles.slice(0, 12).join("; ")}. ` : "") +
    (preferTitles.length ? `These were judged HIGHLY relevant before — prefer them when they fit: ${preferTitles.slice(0, 12).join("; ")}. ` : "");
  const user = `SOURCE POST: ${source.title}\n\nSOURCE BODY:\n${source.text.slice(0, BODY_CHARS)}\n\nCANDIDATE POSTS:\n${list}`;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: "user", content: user }] }),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const arr = parseArray(text);
    return arr.filter((o): o is RawOpp => !!o && typeof o === "object" && typeof (o as RawOpp).target === "number");
  } catch { return []; }
}
function parseArray(text: string): unknown[] {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try { const p = JSON.parse(m[0]); return Array.isArray(p) ? p : []; } catch { return []; }
}

// ---------- store ----------
const RUNS = "content_crosslink_runs";
const LINKS = "content_crosslinks";
const FB = "content_crosslink_feedback";

export type Opportunity = {
  id: string; source_id: string; source_title: string | null; source_slug: string | null;
  target_id: string; target_title: string | null; target_slug: string | null;
  anchor: string | null; context: string | null; rationale: string | null; score: number | null; status: string;
};
export type Feedback = { source_id: string; target_id: string; rating: "up" | "down"; note: string | null };

export async function latestRun(): Promise<{ id: string; status: string; started_at: string; finished_at: string | null; posts: number | null; opportunities: number | null; error: string | null } | null> {
  const { data } = await getDb().from(RUNS).select("*").order("started_at", { ascending: false }).limit(1).maybeSingle();
  return (data as never) || null;
}
export async function listOpportunities(runId: string): Promise<Opportunity[]> {
  const { data } = await getDb().from(LINKS).select("*").eq("run_id", runId).order("score", { ascending: false });
  return (data as Opportunity[]) || [];
}
export async function listFeedback(): Promise<Feedback[]> {
  const { data } = await getDb().from(FB).select("source_id,target_id,rating,note");
  return (data as Feedback[]) || [];
}
export async function upsertFeedback(source_id: string, target_id: string, rating: "up" | "down", note: string | null, by: string | null): Promise<void> {
  await getDb().from(FB).upsert({ source_id, target_id, rating, note, by_email: by, updated_at: new Date().toISOString() }, { onConflict: "source_id,target_id" });
}
export async function setOpportunityStatus(id: string, status: string): Promise<void> {
  await getDb().from(LINKS).update({ status }).eq("id", id);
}

// ---------- orchestrator ----------
async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// Run the whole analysis: fetch posts, generate candidates, LLM-rank, persist. Returns the run id.
export async function analyzeCrosslinks(by: string | null): Promise<{ runId: string; posts: number; opportunities: number }> {
  const collectionId = process.env.WEBFLOW_BLOG_POSTS_ID!;
  const { fields, items } = await loadCollectionResolved(collectionId, { live: false }); // false = staged set = published + draft
  const posts = toPosts(fields, items);
  const bySlugId = new Map(posts.map((p) => [p.slug, p.id]));
  void bySlugId;
  const vecs = buildVectors(posts);

  // Feedback for training: avoid down-voted pairs, prefer up-voted.
  const fbRows = await listFeedback();
  const fb = new Map<string, "up" | "down">();
  for (const f of fbRows) fb.set(`${f.source_id}|${f.target_id}`, f.rating);
  const titleById = new Map(posts.map((p) => [p.id, p.title]));

  const run = await getDb().from(RUNS).insert({ started_by: by, status: "running", posts: posts.length }).select("id").single();
  const runId = (run.data as { id: string }).id;

  let total = 0;
  await pool(posts, CONCURRENCY, async (src, si) => {
    // Candidate shortlist: most similar posts, excluding self + already-linked + down-voted.
    const scored = posts
      .map((p, pi) => ({ p, s: pi === si ? -1 : sim(vecs[si], vecs[pi]) }))
      .filter((x) => x.s > 0 && !src.linkedSlugs.has(x.p.slug) && fb.get(`${src.id}|${x.p.id}`) !== "down")
      .sort((a, b) => b.s - a.s)
      .slice(0, CANDIDATES_PER_POST)
      .map((x) => x.p);
    if (!scored.length) return;
    const avoid = fbRows.filter((f) => f.source_id === src.id && f.rating === "down").map((f) => titleById.get(f.target_id) || "").filter(Boolean);
    const prefer = fbRows.filter((f) => f.source_id === src.id && f.rating === "up").map((f) => titleById.get(f.target_id) || "").filter(Boolean);
    const raw = await llmOpps(src, scored, avoid, prefer);
    const rows = raw
      .map((o) => {
        const target = scored[o.target];
        if (!target) return null;
        const anchor = String(o.anchor || "").trim();
        // Anchor must actually appear in the source body (drop hallucinations).
        if (!anchor || !src.text.toLowerCase().includes(anchor.toLowerCase())) return null;
        let score = Math.max(0, Math.min(100, Number(o.score) || 0));
        if (fb.get(`${src.id}|${target.id}`) === "up") score = Math.min(100, score + 25); // boost confirmed-good
        return {
          run_id: runId, source_id: src.id, source_title: src.title, source_slug: src.slug,
          target_id: target.id, target_title: target.title, target_slug: target.slug,
          anchor, context: String(o.context || "").slice(0, 400), rationale: String(o.reason || "").slice(0, 300), score,
        };
      })
      .filter(Boolean) as Record<string, unknown>[];
    if (rows.length) { await getDb().from(LINKS).insert(rows); total += rows.length; }
  });

  await getDb().from(RUNS).update({ status: "done", finished_at: new Date().toISOString(), opportunities: total }).eq("id", runId);
  return { runId, posts: posts.length, opportunities: total };
}
