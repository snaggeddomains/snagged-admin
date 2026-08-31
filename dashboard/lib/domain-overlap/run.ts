// Orchestrate one overlap match run: build the index from the current corpus, pull
// the day's new candidates, match, and persist the flags. Returns a summary.

import { readCorpusAnchors } from "../domain-corpus/store";
import { buildIndex, matchCandidate, PREFIXES, SUFFIXES, type Flag } from "./match";
import { readCandidatesBySld, readAuctionCandidates, dictionaryWords } from "./candidates";
import { writeFlags } from "./store";

export type OverlapSummary = {
  ok: boolean;
  runDate: string;
  anchors: number;
  guardedSlds: number;
  restrictedSlds: number;
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

    // Match by SLD, not by first_seen date (that scan times out on 7.3M rows; the sld
    // index makes IN(...) fast). We query BOTH the exact corpus SLDs (→ T1, same word
    // other TLD) AND every affixed form (prefix+sld / sld+suffix → T2, .com variations),
    // so matchCandidate sees the full candidate set. writeFlags carries dismissals
    // forward and reports first-time matches so the digest stays edge-triggered.
    const coreSlds = [...idx.sldIndex.keys()];
    const affixed: string[] = [];
    for (const sld of coreSlds) {
      if (idx.restrictedSlds.has(sld)) continue; // dictionary-word anchor = T1 exact-major-TLD only, no affix candidates
      for (const p of PREFIXES) affixed.push(p + sld);
      for (const s of SUFFIXES) affixed.push(sld + s);
    }
    // Sale candidates (name_universe, by SLD) + AUCTION candidates (live auction feeds,
    // which never enter name_universe). Auctions are the time-sensitive signal.
    const saleCandidates = await readCandidatesBySld([...new Set([...coreSlds, ...affixed])]);
    const auctionCandidates = await readAuctionCandidates();

    // Dedupe by candidate_domain; a name that's BOTH listed and on auction resolves to
    // auction (the urgent one). Also avoids duplicate keys in the upsert batch.
    const byDomain = new Map<string, Flag>();
    for (const c of [...saleCandidates, ...auctionCandidates]) {
      const f = matchCandidate(c, idx);
      if (!f) continue;
      const prev = byDomain.get(f.candidate_domain);
      if (!prev || (f.kind === "auction" && prev.kind !== "auction")) byDomain.set(f.candidate_domain, f);
    }
    const flags = [...byDomain.values()];
    const { newDomains } = await writeFlags(runDate, flags);
    const newFlags = flags.filter((f) => newDomains.has(f.candidate_domain));

    return {
      ok: true,
      runDate,
      anchors: anchors.length,
      guardedSlds: idx.guarded,
      restrictedSlds: idx.restrictedSlds.size,
      candidates: saleCandidates.length + auctionCandidates.length,
      flags: flags.length,
      exactTld: flags.filter((f) => f.best_tier === "exact_tld").length,
      affix: flags.filter((f) => f.best_tier === "affix").length,
      newFlags, // only the first-time matches → what the digest alerts on
    };
  } catch (e) {
    const error = String((e as Error)?.message || e);
    console.error(`[overlap] run failed: ${error}`);
    return { ok: false, runDate, anchors: 0, guardedSlds: 0, restrictedSlds: 0, candidates: 0, flags: 0, exactTld: 0, affix: 0, newFlags: [], error };
  }
}
