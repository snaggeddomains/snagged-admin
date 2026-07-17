// Reddit domain-opportunity scoring model (spec §5.6–5.14). Hand-tuned + explainable
// on purpose — no LLM/embeddings. Every signal is an integer-weighted term or phrase;
// a post's score, buy/sell lean, and domain-context determine its bucket. Pure, no I/O.
//
// The tables are the tuning surface: change a weight, not an if/else. Weights aren't
// enumerated in the spec (it says "higher-intent acquisition terms receive larger
// weights"), so these are set to hit the documented behavior — strong buy-side +
// context clears the HIGH_QUALITY_SCORE_MIN=14 floor; seller spam / off-topic sinks.

export type Bucket = "high-signal" | "maybe" | "ignore" | "feed-error";

export const HIGH_QUALITY_SCORE_MIN = 14; // Slack-push + high-signal floor (spec §5.13)
const MAYBE_MIN = 6;

// Subreddits where domain context can be ASSUMED (context gating is relaxed here).
export const DOMAIN_NATIVE = new Set(["domains", "domainnames"]);

// Weighted positive terms (§5.7) — acquisition/broker intent scores highest.
const POSITIVE: [string, number][] = [
  ["need a domain broker", 9], ["looking for a domain broker", 9], ["recommend a domain broker", 8],
  ["hire a domain broker", 8], ["best domain broker", 7], ["premium domain broker", 7],
  ["domain broker", 6], ["broker recommendation", 6],
  ["acquire a domain", 8], ["acquire the domain", 8], ["domain acquisition", 7],
  ["help me buy this domain", 8], ["buy this domain", 6], ["buy a domain", 6], ["buying a domain", 6],
  ["buying a premium domain", 6], ["premium domain", 4],
  ["owner not responding", 9], ["owner is not responding", 9], ["can't contact the owner", 8], ["who owns", 4],
  ["parked domain", 4], ["parked", 2],
  ["rebrand", 4], ["rebranding", 4], ["brand name", 2],
  ["whois", 3], ["escrow", 3], ["sedo", 3], ["afternic", 3], ["godaddy", 3], ["atom.com", 3],
  ["valuation", 3], ["appraisal", 3], ["trademark", 2],
  ["domain name", 2], ["domains", 1], ["domain", 1],
];

// Weighted negative terms (§5.8) — seller spam / support chatter / weak relevance.
const NEGATIVE: [string, number][] = [
  ["for sale", 6], ["sell domains", 6], ["sold domains", 6], ["selling my domain", 6], ["sell my domain", 6],
  ["selling", 4], ["bin", 4], ["logo", 4], ["cold email", 5], ["backlinks", 7], ["hosting", 4],
  ["traffic", 3], ["newsletter", 6], ["payout", 5],
  ["client interested in a domain i own", 8], ["domain i own", 6], ["broker from", 3],
];

// Domain-context terms (§5.9). A generic phrase in a non-native subreddit needs one
// of these (or a TLD) to count as an actual domain opportunity.
const DOMAIN_CONTEXT = [
  "domain name", "domain", "domains", "brand name", "rebrand", "whois", "sedo", "afternic",
  "atom.com", "godaddy", "escrow", "trademark", "appraisal", "valuation",
];
const TLD_RE = /\b[a-z0-9-]{2,}\.(com|ai|io|co|net|org)\b/;

// Strong-exclude phrase collisions (§5.10) — force IGNORE even if other terms hit.
const STRONG_EXCLUDE = [
  "who owns the next action", "market research survey", "consumer research survey",
  "streetwear brand", "back office automation", "ai stacks",
];

// High-signal hints (§5.11) — explicit acquisition intent; each adds a bonus when
// paired with domain context.
const HIGH_SIGNAL_HINTS = [
  "trying to buy", "want to buy", "looking to buy", "looking to acquire", "trying to acquire",
  "owner is not responding", "owner not responding", "can't contact the owner", "cannot contact the owner",
  "domain broker", "domain is taken", "parked", "who owns", "rebrand", "rebranding",
];
const HINT_BONUS = 4;

// Buy-side vs sell-side lean (§5.12).
const BUY_SIDE = [
  "trying to buy", "want to buy", "looking to buy", "need a broker", "domain owner not responding",
  "buy this domain", "acquire this domain", "parked domain", "need this domain", "how do i buy",
];
const SELL_SIDE = [
  "for sale", "buy now", "sell my domain", "selling my domain", "interested in a domain i own",
  "broker contacted me", "payout", "i'm selling", "i am selling",
];

function countHits(haystack: string, terms: string[]): string[] {
  return terms.filter((t) => haystack.includes(t));
}

export type Scored = {
  score: number;
  bucket: Bucket;
  buySide: boolean;
  sellSide: boolean;
  hasContext: boolean;
  matched: string[]; // the positive/hint terms that fired (the "why")
  sample: string; // advisory sample-response angle (§5.14)
};

/** Score + classify one Reddit post. `text` = title + content; `subreddit` lowercased. */
export function scorePost(text: string, subreddit: string): Scored {
  const h = ` ${String(text || "").toLowerCase()} `;
  const sub = String(subreddit || "").toLowerCase();

  // Strong-exclude → immediate ignore.
  if (STRONG_EXCLUDE.some((p) => h.includes(p))) {
    return { score: -99, bucket: "ignore", buySide: false, sellSide: false, hasContext: false, matched: [], sample: "" };
  }

  const hasContext = DOMAIN_NATIVE.has(sub) || DOMAIN_CONTEXT.some((t) => h.includes(t)) || TLD_RE.test(h);

  const matched: string[] = [];
  let score = 0;
  for (const [term, w] of POSITIVE) if (h.includes(term)) { score += w; matched.push(term); }
  for (const [term, w] of NEGATIVE) if (h.includes(term)) score -= w;

  const hints = countHits(h, HIGH_SIGNAL_HINTS);
  if (hasContext) { score += hints.length * HINT_BONUS; matched.push(...hints); }

  const buyHits = countHits(h, BUY_SIDE);
  const sellHits = countHits(h, SELL_SIDE);
  const buySide = buyHits.length > 0;
  const sellSide = sellHits.length > 0;
  // Sell-side language with no buy-side intent is a seller post — push it down.
  if (sellSide && !buySide) score -= 6;

  // Context gating (§5.9): a keyword hit without real domain context outside the
  // native subreddits can't be a high/maybe opportunity.
  if (!hasContext) score = Math.min(score, MAYBE_MIN - 1);

  let bucket: Bucket;
  if (score >= HIGH_QUALITY_SCORE_MIN && hasContext && (buySide || !sellSide)) bucket = "high-signal";
  else if (score >= MAYBE_MIN && hasContext) bucket = "maybe";
  else bucket = "ignore";

  return { score, bucket, buySide, sellSide, hasContext, matched: [...new Set(matched)], sample: sampleResponse(h, buySide) };
}

// Advisory sample-response angle (§5.14) — NOT auto-posted; just quick framing.
function sampleResponse(h: string, buySide: boolean): string {
  if (/owner (is )?not responding|can'?t contact the owner|cannot contact the owner|who owns/.test(h))
    return "Owner-unreachable angle: offer to run ownership/contact research and broker the outreach.";
  if (/domain broker|need a broker|recommend a .*broker/.test(h))
    return "Broker-need angle: introduce Snagged as the acquisition broker; ask for the target name + budget.";
  if (/rebrand|brand name|naming/.test(h))
    return "Rebrand/naming angle: offer a naming exercise + a shortlist of acquirable premium .coms.";
  if (/appraisal|valuation|worth|how much/.test(h))
    return "Valuation angle: offer a defensible appraisal + comps, then a path to acquire if they're buying.";
  if (buySide)
    return "Buy-side angle: confirm the target domain + budget, then offer to source/broker the acquisition.";
  return "General domain-community ask: light, helpful reply establishing Snagged as the acquisition partner.";
}
