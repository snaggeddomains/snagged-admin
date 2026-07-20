// Reddit sweep orchestrator: fetch every subreddit's /new feed, score each post,
// keep the high-signal + maybe buckets, persist (deduped), and report the net-new
// posts for the digest. Fully fail-open per subreddit (a feed error is bucketed, not
// fatal). The X sweep will add its own fetch+run but share the score model + store.

import { subreddits } from "./subreddits";
import { fetchSubreddit } from "./fetch";
import { scorePost } from "./score";
import { draftReplies } from "./reply";
import { upsertPosts, logSweepRun, mutedSet, type SweepPost } from "./store";

export type SweepSummary = {
  ok: boolean;
  platform: "reddit";
  subs: number;
  fetched: number;
  high: number;
  maybe: number;
  newPosts: SweepPost[]; // net-new high+maybe → what the digest alerts on
  feedErrors: string[];
  error?: string;
};

const MAX_AGE_DAYS = 7; // calibration + relevance: only the last 7 days of posts

function withinWindow(published: string | null): boolean {
  if (!published) return true; // unknown date — keep (Reddit /new is recent anyway)
  const t = Date.parse(published);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= MAX_AGE_DAYS * 86400_000;
}

// Bounded-concurrency map (Reddit + scrape.do are happier without 25 parallel hits).
async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return out;
}

export async function runRedditSweep(): Promise<SweepSummary> {
  const subs = subreddits();
  try {
    const feedErrors: string[] = [];
    let fetched = 0;
    const scored: SweepPost[] = [];
    const muted = await mutedSet(); // skip muted authors before the LLM reply-draft

    await pool(subs, 4, async (sub) => {
      let posts;
      try {
        posts = await fetchSubreddit(sub);
      } catch {
        feedErrors.push(sub); // Reddit block / parse error → bucket, don't fail the run
        return;
      }
      const recent = posts.filter((p) => withinWindow(p.published));
      fetched += recent.length;
      for (const p of recent) {
        if (p.author && muted.has(p.author.toLowerCase())) continue; // muted author
        const s = scorePost(`${p.title}\n${p.content}`, p.subreddit);
        if (s.bucket !== "high-signal" && s.bucket !== "maybe") continue; // discard ignores
        scored.push({
          id: `reddit:${p.link}`,
          platform: "reddit",
          source: p.subreddit,
          title: p.title,
          link: p.link,
          author: p.author || null,
          published: p.published,
          score: s.score,
          bucket: s.bucket,
          buy_side: s.buySide,
          sell_side: s.sellSide,
          matched: s.matched,
          sample: s.sample,
          snippet: (p.content || "").slice(0, 400),
          followers: null, // Reddit RSS has no follower signal
          verified: false,
          suggested_reply: "",
        });
      }
    });

    // Draft a suggested reply (Snagged's voice) for each kept post — best-effort.
    const drafts = await draftReplies(scored);
    for (const p of scored) p.suggested_reply = drafts.get(p) || "";

    const { newIds } = await upsertPosts(scored);
    const newPosts = scored.filter((p) => newIds.has(p.id));
    const high = scored.filter((p) => p.bucket === "high-signal").length;
    const maybe = scored.filter((p) => p.bucket === "maybe").length;

    await logSweepRun({
      platform: "reddit", fetched, scored: scored.length, high, maybe,
      new_count: newPosts.length, feed_errors: feedErrors, ok: true, error: null,
    });

    return { ok: true, platform: "reddit", subs: subs.length, fetched, high, maybe, newPosts, feedErrors };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[reddit-sweep] run failed: ${error}`);
    await logSweepRun({ platform: "reddit", fetched: 0, scored: 0, high: 0, maybe: 0, new_count: 0, feed_errors: [], ok: false, error });
    return { ok: false, platform: "reddit", subs: subs.length, fetched: 0, high: 0, maybe: 0, newPosts: [], feedErrors: [], error };
  }
}
