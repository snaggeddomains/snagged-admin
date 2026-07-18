// Self-test for the sweep score model. Encodes the calibration philosophy (Rob,
// 2026-07-17): flag OUTSIDERS (founders / VCs / investors) talking about domains;
// EXCLUDE the domainer echo chamber (brokers, investors, sellers, portfolio shop-talk).
// Run: npx tsx scripts/reddit_score_selftest.ts

import { scorePost } from "../lib/reddit-sweep/score";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); } }
const b = (text: string, sub: string) => scorePost(text, sub).bucket;

// ── OUTSIDERS we WANT → high-signal ──
ok("founder needs the .com (r/startups)",
  b("We just raised our seed round and the .com for our startup is taken — how do we buy this domain?", "startups") === "high-signal");
ok("founder just bought a domain (r/Entrepreneur)",
  b("Just bought a domain for my company, did I overpay? Thinking about our brand going forward.", "entrepreneur") === "high-signal");
ok("founder asking for a broker (r/SaaS)",
  b("Looking for a domain broker to help acquire the .com for our SaaS — owner is not responding.", "saas") === "high-signal");
ok("VC discussing digital assets (r/venturecapital)",
  b("How do you think about domain names as digital assets for portfolio companies rebranding?", "venturecapital") === "high-signal");

// ── INSIDERS / echo chamber → ignore ──
ok("domainer portfolio review (r/Domains)",
  b("Roast my portfolio — 200 domains I own, mostly hand reg, what should I renew?", "domains") === "ignore");
ok("seller listing for sale (r/Domains)",
  b("Premium domain for sale, make offer. Listed on Afternic and Sedo, my asking price is 5k.", "domains") === "ignore");
ok("domain investor flipping (r/Flipping)",
  b("As a domainer I flip domains from expired auctions — what's my domain worth on NameBio?", "flipping") === "ignore");
ok("generic domainer shop-talk (r/Domains) not high",
  b("Anyone else seeing weak sales this quarter across their portfolio?", "domains") !== "high-signal");

// ── Off-topic / no context → ignore ──
ok("off-topic (r/startups) no domain context",
  b("What CRM should we use for our early-stage sales team?", "startups") === "ignore");
ok("pure seller in a target sub still not high",
  b("Selling my domain, make an offer.", "entrepreneur") !== "high-signal");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
