// The overlap matcher. Given the client corpus (anchors) and newly-seen candidate
// names, flag the ones worth sending a client:
//   T1  exact SLD on a DIFFERENT TLD   (howie.com anchor → howie.co / .ai / .io …)
//   T2  affix variation, .com ONLY     (howie.com anchor → gethowie.com / howieapp.com)
// Never: affix variations on non-.com TLDs; never a domain already in the corpus.
// Noise guard: an anchor SLD that is ≤3 chars or a common dictionary word is dropped
// (a client who once dealt `go.com` shouldn't flag on go.io / getgo.com …).

import type { CorpusAnchor } from "../domain-corpus/store";

// Affix sets — the curated high-signal list Rob locked (screenshot 2026-07-17), a
// tightened subset of the research app's Beast Mode affixes. Only these prefixes/
// suffixes generate T2 (.com variation) candidates, so low-signal affixes (io/ai/
// pro/net/…) no longer manufacture noisy matches.
export const PREFIXES = [
  "try", "use", "get", "the", "meet", "open", "hi", "hello", "go",
];
export const SUFFIXES = [
  "ly", "app", "labs", "hub", "hq", "lab",
];

// If the client already owns the .com, an exact-SLD variant is only worth flagging
// on a MAJOR/liquid TLD — never the long tail (.xyz/.gg/.me/.dev/…). Owning the .com
// makes minor-TLD variants noise (Rob, 2026-07-17). When the client does NOT own the
// .com (e.g. they hold root.ai), every exact-SLD match still flags — including root.com,
// the upgrade.
const MAJOR_TLDS = new Set(["com", "net", "org", "co", "io", "ai"]);

export type Candidate = {
  domain: string;
  sld: string;
  tld: string; // bare (no dot)
  feed: string | null;
  price: number | null;
  priceSource: string | null;
  kind?: "sale" | "auction"; // default 'sale' (marketplace listing)
  endsAt?: string | null; // auction end time (ISO) — drives urgency
  link?: string | null; // direct listing/auction URL (auctions provide one)
};

export type MatchEntry = { anchor: string; clients: string[]; tier: "exact_tld" | "affix"; affix: string | null };

export type Flag = {
  candidate_domain: string;
  candidate_sld: string;
  candidate_tld: string;
  best_tier: "exact_tld" | "affix";
  clients: string[];
  matches: MatchEntry[];
  source_feed: string | null;
  price: number | null;
  price_source: string | null;
  link: string | null;
  kind: "sale" | "auction";
  ends_at: string | null; // auction end time (ISO), else null
};

export type MatchIndex = {
  sldIndex: Map<string, CorpusAnchor[]>; // non-guarded anchor SLD → anchors
  corpusDomains: Set<string>; // every corpus apex (skip exact-in-corpus candidates)
  guarded: number; // count of anchor SLDs dropped by the noise guard
};

/**
 * Build the match index from the corpus. `isDictionaryWord` decides the noise guard
 * for words >3 chars; short (≤3) SLDs are always guarded.
 */
export function buildIndex(anchors: CorpusAnchor[], dictionarySet: Set<string>): MatchIndex {
  const sldIndex = new Map<string, CorpusAnchor[]>();
  const corpusDomains = new Set<string>();
  let guarded = 0;
  const guardedSlds = new Set<string>();
  for (const a of anchors) {
    corpusDomains.add(a.domain);
    if (!a.sld) continue;
    if (a.sld.length <= 3 || dictionarySet.has(a.sld)) {
      if (!guardedSlds.has(a.sld)) { guardedSlds.add(a.sld); guarded++; }
      continue;
    }
    const list = sldIndex.get(a.sld);
    if (list) list.push(a);
    else sldIndex.set(a.sld, [a]);
  }
  return { sldIndex, corpusDomains, guarded };
}

function marketLink(feed: string | null, domain: string): string | null {
  const f = (feed || "").toLowerCase();
  if (f.includes("afternic")) return `https://www.afternic.com/domain/${domain}`;
  if (f.includes("sedo")) return `https://sedo.com/search/?keyword=${domain}`;
  if (f.includes("atom")) return `https://www.atom.com/name/${encodeURIComponent(domain.split(".")[0])}`;
  if (f.includes("namecheap")) return `https://www.namecheap.com/market/?term=${domain}`;
  return `https://${domain}`;
}

/** Match one candidate against the index; returns a Flag or null. */
export function matchCandidate(c: Candidate, idx: MatchIndex): Flag | null {
  if (!c.sld) return null;
  if (idx.corpusDomains.has(c.domain)) return null; // already ours/known — never flag

  const matches: MatchEntry[] = [];
  const seen = new Set<string>(); // anchor+tier de-dupe

  // T1 — exact SLD, different TLD (the candidate can't be an exact corpus domain; that
  // was filtered above, so any same-SLD anchor is necessarily a different TLD/registration).
  const sameSld = idx.sldIndex.get(c.sld) || [];
  // If ANY owned anchor for this word is the .com, a minor-TLD candidate is noise — skip it.
  const ownsCom = sameSld.some((a) => a.tld === "com");
  if (!(ownsCom && !MAJOR_TLDS.has(c.tld))) {
    for (const a of sameSld) {
      const key = `${a.domain}|exact_tld`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ anchor: a.domain, clients: a.clients, tier: "exact_tld", affix: null });
    }
  }

  // T2 — affix variation, .com ONLY. Strip each affix; a resulting CORE that's a
  // (non-guarded) corpus SLD is a hit. The guard on cores prevents junk (getaway→away).
  // If the client already owns core.com, a .com affix variation is noise too — you own
  // cosmo.com, you don't care about trycosmo.com (Rob, 2026-07-17). So skip a core whose
  // anchor set includes the .com; keep it only when they hold the word on non-.com.
  const coreOwnsCom = (core: string) => (idx.sldIndex.get(core) || []).some((a) => a.tld === "com");
  if (c.tld === "com") {
    for (const p of PREFIXES) {
      if (c.sld.length > p.length && c.sld.startsWith(p)) {
        const core = c.sld.slice(p.length);
        if (coreOwnsCom(core)) continue; // owns the .com → affix variation is noise
        for (const a of idx.sldIndex.get(core) || []) {
          const key = `${a.domain}|affix`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ anchor: a.domain, clients: a.clients, tier: "affix", affix: `${p}-` });
        }
      }
    }
    for (const s of SUFFIXES) {
      if (c.sld.length > s.length && c.sld.endsWith(s)) {
        const core = c.sld.slice(0, c.sld.length - s.length);
        if (coreOwnsCom(core)) continue; // owns the .com → affix variation is noise
        for (const a of idx.sldIndex.get(core) || []) {
          const key = `${a.domain}|affix`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ anchor: a.domain, clients: a.clients, tier: "affix", affix: `-${s}` });
        }
      }
    }
  }

  if (!matches.length) return null;
  const bestTier: "exact_tld" | "affix" = matches.some((m) => m.tier === "exact_tld") ? "exact_tld" : "affix";
  const clients = [...new Set(matches.flatMap((m) => m.clients))].sort();
  return {
    candidate_domain: c.domain,
    candidate_sld: c.sld,
    candidate_tld: c.tld,
    best_tier: bestTier,
    clients,
    matches,
    source_feed: c.feed,
    price: c.price,
    price_source: c.priceSource,
    link: c.link || marketLink(c.feed, c.domain),
    kind: c.kind || "sale",
    ends_at: c.endsAt || null,
  };
}
