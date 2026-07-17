// Orchestrate one overlap match run: build the index from the current corpus, pull
// the day's new candidates, match, and persist the flags. Returns a summary.

import { readCorpusAnchors } from "../domain-corpus/store";
import { buildIndex, matchCandidate, type Flag } from "./match";
import { readNewCandidates, readCandidatesBySld, dictionaryWords } from "./candidates";
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

export async function runOverlap(_opts: { since?: string; backfill?: boolean } = {}): Promise<OverlapSummary> {
  const runDate = todayISO();
  try {
    const anchors = await readCorpusAnchors();
    const dict = await dictionaryWords(anchors.map((a) => a.sld));
    const idx = buildIndex(anchors, dict);

    // Match by CORPUS SLD, not by first_seen date. name_universe.first_seen scans
    // time out at this scale; querying by the (indexed) sld is fast AND surfaces every
    // standing overlap, not just names listed today. writeFlags carries dismissals
    // forward and reports which candidates are flagged for the FIRST time, so the
    // Slack/email digest stays edge-triggered (only genuinely new matches).
    const candidates = await readCandidatesBySld([...idx.sldIndex.keys()]);
    const flags: Flag[] = [];
    for (const c of candidates) {
      const f = matchCandidate(c, idx);
      if (f) flags.push(f);
    }
    const { newDomains } = await writeFlags(runDate, flags);
    const newFlags = flags.filter((f) => newDomains.has(f.candidate_domain));

    return {
      ok: true,
      runDate,
      anchors: anchors.length,
      guardedSlds: idx.guarded,
      candidates: candidates.length,
      flags: flags.length,
      exactTld: flags.filter((f) => f.best_tier === "exact_tld").length,
      affix: flags.filter((f) => f.best_tier === "affix").length,
      newFlags, // only the first-time matches → what the digest alerts on
    };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[overlap] run failed: ${error}`);
    return { ok: false, runDate, anchors: 0, guardedSlds: 0, candidates: 0, flags: 0, exactTld: 0, affix: 0, newFlags: [], error };
  }
}
