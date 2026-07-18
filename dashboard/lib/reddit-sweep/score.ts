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
  ["domain is taken", 6], ["name is taken", 4], [".com is taken", 6],
  ["need a domain broker", 6], ["looking for a domain broker", 6], ["good domain broker", 6],
  ["best domain broker", 6], ["reliable domain broker", 6], ["trustworthy domain broker", 6],
  ["recommend a domain broker", 6], ["domain broker recommendation", 6], ["domain broker", 3],
  ["rebrand", 4], ["rebranding", 4], ["renaming our", 5], ["new name for our", 5],
  ["brand name", 2], ["startup name", 3], ["company name", 2], ["naming my", 3], ["naming our", 3],
  ["digital asset", 3], ["digital assets", 3],
  ["domain name", 3], ["get the .com", 4], ["upgrade to the .com", 6],
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
  // Domainer portfolios / community handles = seller/insider, not our audience.
  "domain portfolio", "premium domain portfolio", "part of a portfolio", "portfolio is now available",
  "portfolio is available", "curated domains", "curated domain", "namepros", "tldinvestors",
  "available for acquisition", "now available for acquisition", "owning a piece of a premium",
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

// Domain-NAME / digital-asset context. Deliberately EXCLUDES the bare word "domain"
// (software sense — "public domain", "problem domain", "who owns updating the docs")
// which was the top noise source; requires a real domain-name signal.
// A REAL domain-acquisition/topic phrase — NOT a bare ".com" or a URL (founders link
// URLs constantly, which flooded the engage bucket). The post has to actually be ABOUT
// a domain: buying/acquiring one, a broker, an unreachable owner, the .com being taken,
// a registrar/marketplace, appraisal, or a rebrand/rename.
const DOMAIN_CONTEXT = [
  "domain name", "domain broker", "domainer", "domain investing", "buy a domain", "buy the domain",
  "buy this domain", "buying a domain", "bought a domain", "acquire a domain", "acquire the domain",
  "acquiring a domain", "purchase a domain", "register a domain", "the domain name",
  ".com is taken", "the .com for", "get the .com", "getting the .com", "need the .com", "want the .com",
  "grab the .com", "secure the .com", "the right .com", "own the .com", "domain for our", "domain for my",
  "premium domain", "digital asset", "whois", "sedo", "afternic", "godaddy", "namecheap", "dan.com",
  "escrow.com", "domain appraisal", "domain valuation", "rebrand", "rebranding", "renaming our",
  "new name for our", "the domain is", "this domain", "a domain", "the domain", "that domain",
  "our domain", "my domain", "the name is taken", "name is already taken", "someone owns",
  "already owns the", "domain squatter", "squatting on", "cybersquat", "the .com i", "the .com version",
  "good .com", "clean .com", "domain i want", "domain we want",
];

const STRONG_EXCLUDE = [
  "who owns the next action", "market research survey", "consumer research survey",
  "streetwear brand", "back office automation", "ai stacks",
  // Crypto reply-bot spam ("@handle I recommend you buy this domain name").
  "i recommend you buy this domain", "recommend you buy this domain name",
];

const HIGH_SIGNAL_HINTS = [
  "trying to buy", "want to buy", "looking to buy", "looking to acquire", "trying to acquire",
  "owner not responding", "can't contact the owner", "cannot contact the owner",
  "domain is taken", "how do i buy", "how to buy the domain", "need help buying", "help buying a domain",
  "rebrand", "rebranding", "just bought a domain", "which domain should",
  "good domain broker", "best domain broker", "reliable domain broker", "recommend a domain broker",
  "looking for a domain broker", "need a domain broker",
];
const HINT_BONUS = 3;

const BUY_SIDE = [
  "trying to buy", "want to buy", "looking to buy", "owner not responding",
  "buy this domain", "acquire this domain", "need this domain", "how do i buy", "help buying",
  "bought a domain", "just bought", "get the .com", "upgrade to the .com",
  "good domain broker", "best domain broker", "reliable domain broker", "recommend a domain broker",
  "looking for a domain broker", "need a domain broker",
];

// HIGH-INTENT signals — the AUTHOR actively seeking a service Snagged provides. Must be
// FIRST-PERSON ("I / we") or an inherently-seeker phrase (broker ask, owner unreachable).
// Bare "buy this domain" is NOT here — it fires on advice ("you should buy this"),
// third-person ("who would want to buy this domain"), and sellers soliciting buyers.
const HIGH_INTENT = [
  // broker ask — inherently a buyer seeking help
  "good domain broker", "best domain broker", "reliable domain broker", "trustworthy domain broker",
  "recommend a domain broker", "domain broker recommendation", "need a domain broker",
  "looking for a domain broker", "hire a domain broker", "who can help me buy",
  // first-person buy intent
  "i want to buy", "we want to buy", "i'm trying to buy", "im trying to buy", "we're trying to buy",
  "i'm looking to buy", "im looking to buy", "we're looking to buy", "i need to buy", "we need to buy",
  "how do i buy", "how do we buy", "how can i buy", "should i buy", "should we buy",
  "help me buy", "help me acquire", "i want to acquire", "we want to acquire", "trying to acquire the",
  "can i buy the domain", "where can i buy the", "how do i get the .com", "how do we get the .com",
  // owner unreachable — a specific acquisition already in motion
  "owner not responding", "owner is not responding", "can't contact the owner", "cannot contact the owner",
  "can't reach the owner", "cannot reach the owner", "owner won't respond", "owner isn't responding",
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

  const hasContext = DOMAIN_CONTEXT.some((t) => h.includes(t));
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

  const highIntent = hits(h, HIGH_INTENT).length > 0;

  let bucket: Bucket;
  // Domainer/seller/noise never qualifies, regardless of intent wording.
  if (insider || pureSeller || !hasContext) bucket = "ignore";
  // 🎯 HIGH INTENT (lead): actively seeking a broker / to buy a specific domain.
  else if (highIntent) bucket = "high-signal";
  // 💬 WORTH ENGAGING (conversation): an outsider discussing domains we can weigh in on.
  else if (outsider && score >= MAYBE_MIN) bucket = "maybe";
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
