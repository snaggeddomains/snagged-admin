// Reddit/X domain-opportunity scoring model. Hand-tuned + explainable on purpose — no
// LLM/embeddings. Every signal is an integer-weighted term; a post's score, buy/sell
// lean, domain context, and INSIDER-vs-OUTSIDER read determine its bucket. Pure, no I/O.
//
// PURPOSE (Rob, 2026-07-17): surface posts where Snagged can add EXPERT authority to
// people OUTSIDE the domain industry — founders, startups, VCs, investors, operators —
// who are talking about domain names / digital assets AT ALL (bought one, want help,
// asking for a broker, discussing them). It is NOT limited to explicit buy intent.
// The HARD filter is excluding the domainer echo chamber: brokers, domain investors,
// sellers, "roast my portfolio", r/Domains shop-talk. Inclusion for the founder/VC
// sphere is deliberately generous — we tighten on real dry-run output.
//
// The tables ARE the tuning surface — change a weight/term, not an if/else.

export type Bucket = "high-signal" | "maybe" | "ignore" | "feed-error";

export const HIGH_QUALITY_SCORE_MIN = 6; // outsider-path high-signal floor (was buy-intent-only 14)
const MAYBE_MIN = 3;

// Subreddits full of DOMAINERS (the echo chamber). A post here is probably an insider —
// demote hard; only a clear outsider signal clears the floor.
export const INSIDER_SUBS = new Set(["domains", "domainnames", "flipping"]);
// Subreddits full of the people we WANT — a domain mention here is an outsider.
export const TARGET_SUBS = new Set([
  "entrepreneur", "startups", "smallbusiness", "saas", "indiehackers", "sideproject",
  "cofounder", "juststart", "business_ideas", "entrepreneurridealong", "venturecapital",
  "growmybusiness", "marketing", "branding", "ecommerce", "shopify", "nocode", "webdev",
  "web_design", "startups_promotion", "advancedentrepreneur", "ycombinator", "investing",
]);

// Positive terms — any domain/naming/digital-asset topic (not just buy intent).
const POSITIVE: [string, number][] = [
  ["acquire a domain", 6], ["acquire the domain", 6], ["domain acquisition", 5],
  ["buy this domain", 6], ["buy a domain", 5], ["buying a domain", 5], ["bought a domain", 5],
  ["bought the domain", 5], ["just bought a domain", 6], ["picked up the domain", 5],
  ["owner not responding", 7], ["can't contact the owner", 6], ["cannot contact the owner", 6],
  ["who owns", 3], ["domain is taken", 6], ["name is taken", 4], [".com is taken", 6],
  ["need a domain broker", 6], ["looking for a domain broker", 6], ["domain broker", 4],
  ["rebrand", 4], ["rebranding", 4], ["renaming our", 5], ["new name for our", 5],
  ["brand name", 2], ["startup name", 3], ["company name", 2], ["naming my", 3], ["naming our", 3],
  ["digital asset", 3], ["digital assets", 3],
  ["domain name", 3], ["get the .com", 4], ["upgrade to the .com", 6], ["domain", 1],
];

// Negative terms — SELLER / support / weak relevance.
const NEGATIVE: [string, number][] = [
  ["for sale", 7], ["make offer", 7], ["make an offer", 7], ["sell domains", 7], ["selling my domain", 7],
  ["sell my domain", 7], ["selling", 3], ["bin ", 3], ["logo", 4], ["cold email", 5], ["backlinks", 7],
  ["hosting", 4], ["newsletter", 6], ["payout", 5],
];

// INSIDER / DOMAINER tells — near-exclude. Already deep in the domain space; piling in
// adds nothing. Heavy penalty AND flips `insider` (which BLOCKS high-signal outright).
const INSIDER_TELLS = [
  "my portfolio", "my domain portfolio", "rate my portfolio", "roast my portfolio", "portfolio review",
  "domains i own", "names i own", "a domain i own", "domain i own",
  "domain investor", "domain investing", "i'm a domainer", "im a domainer", "as a domainer", "we're domainers",
  "flipping domains", "flip domains", "domain flipping", "flipped a domain",
  "hand reg", "handreg", "handregged", "reg fee", "regged", "drop catch", "dropcatch", "back order", "backorder",
  "expired domain", "expired auction", "godaddy auction", "namebio", "estibot", "closeout",
  "my asking price", "appraise my", "what's my domain worth", "whats my domain worth", "what is my domain worth",
  "just sold my", "just sold a domain", "my sedo", "my afternic", "my dan.com", "my atom.com",
  "add it to my portfolio", "acquired for reg", "sell it for", "wholesale price", "liquidate my",
];

// OUTSIDER signals — founder / VC / investor / operator sphere. Bonus + flips `outsider`
// (which, with domain context, is what clears a post to high-signal).
const OUTSIDER_NEED = [
  "our startup", "my startup", "our company", "my company", "our business", "our brand", "my business",
  "we're building", "we are building", "i'm building", "im building", "we're launching", "launching our",
  "our new product", "our saas", "our app", "our website", "our domain",
  "we raised", "just raised", "seed round", "series a", "series b", "pre-seed", "pre seed", "our seed",
  "just incorporated", "just founded", "co-founder", "cofounder", "founder of", "as a founder",
  "our investor", "angel investor", "venture capital", "portfolio company", "for our company",
  "for our startup", "for my startup", "for our brand", "for our new", "renaming our company", "rebranding our",
];

// Domain / digital-asset context (a generic phrase in a non-target sub needs one / a TLD).
const DOMAIN_CONTEXT = [
  "domain name", "domain", "domains", "brand name", "startup name", "company name", "rebrand",
  "renaming", "digital asset", "whois", "sedo", "afternic", "godaddy", "escrow", "trademark",
  "appraisal", "valuation", ".com", ".io", ".ai", ".co",
];
const TLD_RE = /\b[a-z0-9-]{2,}\.(com|ai|io|co|net|org)\b/;

const STRONG_EXCLUDE = [
  "who owns the next action", "market research survey", "consumer research survey",
  "streetwear brand", "back office automation", "ai stacks",
];

const HIGH_SIGNAL_HINTS = [
  "trying to buy", "want to buy", "looking to buy", "looking to acquire", "trying to acquire",
  "owner not responding", "can't contact the owner", "cannot contact the owner",
  "domain is taken", "how do i buy", "how to buy the domain", "need help buying", "help buying a domain",
  "rebrand", "rebranding", "just bought a domain", "which domain should",
];
const HINT_BONUS = 3;

const BUY_SIDE = [
  "trying to buy", "want to buy", "looking to buy", "need a broker", "owner not responding",
  "buy this domain", "acquire this domain", "need this domain", "how do i buy", "help buying",
  "bought a domain", "just bought", "get the .com", "upgrade to the .com",
];
const SELL_SIDE = [
  "for sale", "make offer", "make an offer", "buy now", "sell my domain", "selling my domain",
  "i'm selling", "i am selling", "payout", "asking price", "my portfolio", "flipping", "liquidate",
];

function hits(haystack: string, terms: string[]): string[] {
  return terms.filter((t) => haystack.includes(t));
}

export type Scored = {
  score: number;
  bucket: Bucket;
  buySide: boolean;
  sellSide: boolean;
  hasContext: boolean;
  insider: boolean; // domainer/seller shop-talk → excluded
  outsider: boolean; // founder/VC/investor sphere → the target
  matched: string[]; // the terms that fired (the "why")
  sample: string; // advisory sample-response angle
};

/** Score + classify one post. `text` = title + content; `subreddit` lowercased ("x" for X). */
export function scorePost(text: string, subreddit: string): Scored {
  const h = ` ${String(text || "").toLowerCase()} `;
  const sub = String(subreddit || "").toLowerCase();

  if (STRONG_EXCLUDE.some((p) => h.includes(p))) {
    return { score: -99, bucket: "ignore", buySide: false, sellSide: false, hasContext: false, insider: false, outsider: false, matched: [], sample: "" };
  }

  const hasContext = DOMAIN_CONTEXT.some((t) => h.includes(t)) || TLD_RE.test(h);
  const insiderTells = hits(h, INSIDER_TELLS);
  const outsiderHits = hits(h, OUTSIDER_NEED);
  const insider = insiderTells.length > 0;
  const outsider = outsiderHits.length > 0 || TARGET_SUBS.has(sub);

  const matched: string[] = [];
  let score = 0;
  for (const [term, w] of POSITIVE) if (h.includes(term)) { score += w; matched.push(term); }
  for (const [term, w] of NEGATIVE) if (h.includes(term)) score -= w;

  score -= Math.min(insiderTells.length, 3) * 12; // echo chamber — heavy demote
  if (outsiderHits.length) { score += outsiderHits.length * 4; matched.push(...outsiderHits); }
  if (TARGET_SUBS.has(sub)) score += 4; // a domain mention in a founder/VC sub is inherently on-target

  const hintHits = hits(h, HIGH_SIGNAL_HINTS);
  if (hasContext) { score += hintHits.length * HINT_BONUS; matched.push(...hintHits); }

  const buyHits = hits(h, BUY_SIDE);
  const sellHits = hits(h, SELL_SIDE);
  const buySide = buyHits.length > 0;
  const sellSide = sellHits.length > 0;
  const pureSeller = sellSide && !buySide;
  if (pureSeller) score -= 6;

  if (INSIDER_SUBS.has(sub) && !outsiderHits.length) score = Math.min(score, MAYBE_MIN - 1);
  if (!hasContext && !TARGET_SUBS.has(sub)) score = Math.min(score, MAYBE_MIN - 1);

  let bucket: Bucket;
  if (insider) bucket = "ignore"; // domainer/seller — never our audience
  // High-signal = an OUTSIDER on a domain/digital-asset topic, in context, not a pure seller.
  else if (hasContext && outsider && !pureSeller && score >= HIGH_QUALITY_SCORE_MIN) bucket = "high-signal";
  else if (hasContext && !pureSeller && score >= MAYBE_MIN) bucket = "maybe";
  else bucket = "ignore";

  return { score, bucket, buySide, sellSide, hasContext, insider, outsider, matched: [...new Set(matched)], sample: sampleResponse(h, buySide) };
}

// Advisory sample-response angle — NOT auto-posted; just quick framing.
function sampleResponse(h: string, buySide: boolean): string {
  if (/owner (is )?not responding|can'?t contact the owner|cannot contact the owner|who owns/.test(h))
    return "Owner-unreachable angle: offer to run ownership/contact research and broker the outreach.";
  if (/rebrand|renaming|new name for|naming (my|our)|company name|startup name/.test(h))
    return "Naming angle: offer a naming exercise + a shortlist of acquirable premium .coms.";
  if (/raised|seed round|series [ab]|founder|our startup|our company/.test(h))
    return "Founder angle: position Snagged as the domain partner — secure the right .com as they scale.";
  if (/appraisal|valuation|worth|how much|digital asset/.test(h))
    return "Valuation/asset angle: offer a defensible read on the name's value + a path to acquire.";
  if (buySide)
    return "Buy-side angle: confirm the target domain + budget, then offer to source/broker the acquisition.";
  return "Expert-authority angle: add a genuinely helpful domain insight; establish Snagged as the go-to.";
}
