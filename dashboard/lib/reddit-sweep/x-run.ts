// X sweep orchestrator: run each recent-search query, score the tweets, keep the
// high-signal + maybe buckets, persist (deduped), report net-new for the digest.
// Shares score.ts + store.ts + digest.ts with the Reddit sweep. Fail-open per query
// (a rate-limit / tier error buckets that query, doesn't fail the run).

import { xQueries, searchX } from "./x-fetch";
import { scorePost } from "./score";
import { draftReplies } from "./reply";
import { upsertPosts, logSweepRun, mutedSet, type SweepPost } from "./store";

export type XSweepSummary = {
  ok: boolean;
  platform: "x";
  queries: number;
  fetched: number;
  high: number;
  maybe: number;
  newPosts: SweepPost[];
  feedErrors: string[];
  error?: string;
};

export async function runXSweep(): Promise<XSweepSummary> {
  const queries = xQueries();
  try {
    const feedErrors: string[] = [];
    let fetched = 0;
    const scored: SweepPost[] = [];
    const seen = new Set<string>();
    const muted = await mutedSet(); // skip muted authors before the LLM reply-draft

    // Sequential (recent search is tightly rate-limited; a small serial loop is safest).
    for (const q of queries) {
      let posts;
      try {
        posts = await searchX(q);
      } catch (e) {
        feedErrors.push(`${q.slice(0, 40)} — ${String((e as Error)?.message || e)}`);
        continue;
      }
      fetched += posts.length;
      for (const p of posts) {
        if (seen.has(p.link)) continue; // a tweet can match several queries
        seen.add(p.link);
        if (p.author && muted.has(p.author.toLowerCase())) continue; // muted author
        const s = scorePost(p.content, "x");
        if (s.bucket !== "high-signal" && s.bucket !== "maybe") continue;
        scored.push({
          id: `x:${p.link}`,
          platform: "x",
          source: p.author || "x",
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
          followers: p.followers,
          verified: p.verified,
          suggested_reply: "",
        });
      }
    }

    const { newIds } = await upsertPosts(scored);
    const newPosts = scored.filter((p) => newIds.has(p.id));
    const high = scored.filter((p) => p.bucket === "high-signal").length;
    const maybe = scored.filter((p) => p.bucket === "maybe").length;

    await logSweepRun({
      platform: "x", fetched, scored: scored.length, high, maybe,
      new_count: newPosts.length, feed_errors: feedErrors, ok: true, error: null,
    });

    return { ok: true, platform: "x", queries: queries.length, fetched, high, maybe, newPosts, feedErrors };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[x-sweep] run failed: ${error}`);
    await logSweepRun({ platform: "x", fetched: 0, scored: 0, high: 0, maybe: 0, new_count: 0, feed_errors: [], ok: false, error });
    return { ok: false, platform: "x", queries: queries.length, fetched: 0, high: 0, maybe: 0, newPosts: [], feedErrors: [], error };
  }
}
