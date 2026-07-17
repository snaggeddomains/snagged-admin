// Self-test for the Reddit scoring model. Run: npx tsx scripts/reddit_score_selftest.ts
import { scorePost, HIGH_QUALITY_SCORE_MIN } from "../lib/reddit-sweep/score";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, got?: unknown) { if (cond) pass++; else { fail++; console.log(`  ✗ ${name}${got !== undefined ? ` (got ${JSON.stringify(got)})` : ""}`); } }

// High-signal buy-side, domain-native subreddit.
let s = scorePost("Trying to buy a domain but the owner is not responding — need a domain broker to help me acquire it", "Domains");
ok("buy-side owner-unreachable → high-signal", s.bucket === "high-signal" && s.buySide, s);
ok("  score clears floor", s.score >= HIGH_QUALITY_SCORE_MIN, s.score);

// Broker ask in a startup subreddit (has domain context via "domain").
s = scorePost("Anyone recommend a domain broker? Trying to acquire a premium .com for our rebrand", "startups");
ok("broker ask + context → high-signal", s.bucket === "high-signal", s);

// Seller spam → ignore.
s = scorePost("Premium domain for sale! BIN $2,500 on Afternic, great for SEO backlinks. Selling my domain now.", "Domains");
ok("seller BIN spam → ignore", s.bucket === "ignore", s);

// Sell-side ('domain i own') → ignore.
s = scorePost("I have a client interested in a domain i own, broker contacted me about the payout", "Entrepreneur");
ok("sell-side/self-inventory → ignore", s.bucket === "ignore", s);

// Strong-exclude collision → ignore even with domainish words.
s = scorePost("Consumer research survey about brand name preferences and back office automation", "marketing");
ok("strong-exclude → ignore", s.bucket === "ignore", s);

// Generic founder post, no domain context, non-native sub → not high/maybe.
s = scorePost("How do I get more traffic and grow my newsletter for my startup?", "startups");
ok("no domain context → ignore", s.bucket === "ignore", s);

// Naming/rebrand with context → at least maybe.
s = scorePost("We're rebranding and need a new brand name — is buying a premium domain worth it?", "branding");
ok("rebrand + premium-domain → high/maybe", s.bucket === "high-signal" || s.bucket === "maybe", s);
ok("  buy sample angle set", !!s.sample, s.sample);

// Valuation ask in native sub → maybe (relevant but not strong buy intent).
s = scorePost("What's the appraisal / valuation on a 5-letter .com? Curious what it's worth", "domainnames");
ok("valuation ask → maybe or high", s.bucket === "maybe" || s.bucket === "high-signal", s);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
