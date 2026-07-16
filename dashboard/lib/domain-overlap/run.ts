// Orchestrate one overlap match run: build the index from the current corpus, pull
// the day's new candidates, match, and persist the flags. Returns a summary.

import { readCorpusAnchors } from "../domain-corpus/store";
import { buildIndex, matchCandidate, type Flag } from "./match";
import { readNewCandidates, dictionaryWords } from "./candidates";
import { writeFlags } from "./store";

export type OverlapSummary = {
  ok: boolean;
  runDate: string;
  anchors: number;
  guardedSlds: number;
  candidates: number;
  flags: number;
  exactTld: number;
  affix: number;
  newFlags: Flag[];
  error?: string;
};

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function runOverlap(opts: { since?: string } = {}): Promise<OverlapSummary> {
  const runDate = todayISO();
  const since = opts.since || runDate;
  try {
    const anchors = await readCorpusAnchors();
    const dict = await dictionaryWords(anchors.map((a) => a.sld));
    const idx = buildIndex(anchors, dict);

    const candidates = await readNewCandidates(since);
    const flags: Flag[] = [];
    for (const c of candidates) {
      const f = matchCandidate(c, idx);
      if (f) flags.push(f);
    }
    await writeFlags(runDate, flags);

    return {
      ok: true,
      runDate,
      anchors: anchors.length,
      guardedSlds: idx.guarded,
      candidates: candidates.length,
      flags: flags.length,
      exactTld: flags.filter((f) => f.best_tier === "exact_tld").length,
      affix: flags.filter((f) => f.best_tier === "affix").length,
      newFlags: flags,
    };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[overlap] run failed: ${error}`);
    return { ok: false, runDate, anchors: 0, guardedSlds: 0, candidates: 0, flags: 0, exactTld: 0, affix: 0, newFlags: [], error };
  }
}
