// Self-test for the overlap match criteria (pure logic, no DB/network).
// Run: npx tsx scripts/overlap_selftest.ts
import { canonicalApex, extractApexes, isIgnoredDomain } from "../lib/domain-corpus/canonical";
import { buildIndex, matchCandidate, type Candidate } from "../lib/domain-overlap/match";
import type { CorpusAnchor } from "../lib/domain-corpus/store";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean) { if (cond) { pass++; } else { fail++; console.log(`  ✗ ${name}`); } }

// ── canonicalization ──
ok("Hello.COM → hello.com", canonicalApex("Hello.COM") === "hello.com");
ok("app.hello.com → hello.com", canonicalApex("app.hello.com") === "hello.com");
ok("hello.ai. → hello.ai", canonicalApex("hello.ai.") === "hello.ai");
ok("https://www.foo.io/x → foo.io", canonicalApex("https://www.foo.io/path?q=1") === "foo.io");
ok("mailto john@bar.co → bar.co", canonicalApex("john@bar.co") === "bar.co");
ok("plain word rejected", canonicalApex("example") === null);
ok("bad tld rejected", canonicalApex("foo.zzzzzz") === null);
ok("co.uk kept whole", canonicalApex("shop.acme.co.uk") === "acme.co.uk");
ok("gmail ignored", isIgnoredDomain("gmail.com"));
ok("snagged ignored", isIgnoredDomain("snagged.com"));
ok('extract "EM1.com monthly" → em1.com', JSON.stringify(extractApexes("EM1.com monthly")) === JSON.stringify(["em1.com"]));
ok('extract "buy hello.ai / hello.com"', JSON.stringify(extractApexes("buy hello.ai / hello.com")) === JSON.stringify(["hello.ai", "hello.com"]));

// ── matcher: client owns howie.com ──
const anchors: CorpusAnchor[] = [
  { domain: "howie.com", sld: "howie", tld: "com", clients: ["Howie Inc"] },
  { domain: "go.com", sld: "go", tld: "com", clients: ["ShortCo"] }, // ≤3 chars → guarded
  { domain: "market.com", sld: "market", tld: "com", clients: ["DictCo"] }, // dictionary → guarded
];
const idx = buildIndex(anchors, new Set(["market"])); // pretend "market" is a dictionary word

const cand = (domain: string): Candidate => {
  const [sld, ...rest] = domain.split(".");
  return { domain, sld, tld: rest.join("."), feed: "afternic", price: 1500, priceSource: "afternic" };
};

// T1 — same word, MAJOR other TLD → FLAG (client owns howie.com)
for (const d of ["howie.co", "howie.ai", "howie.io", "howie.net"]) {
  const f = matchCandidate(cand(d), idx);
  ok(`T1 flag ${d}`, !!f && f.best_tier === "exact_tld" && f.clients.includes("Howie Inc"));
}
// T1 — owns the .com, so minor-TLD variants are NOT flagged (Rob's major-TLD rule)
for (const d of ["howie.xyz", "howie.gg", "howie.me", "howie.dev"]) {
  ok(`no flag ${d} (own .com → minor TLD)`, matchCandidate(cand(d), idx) === null);
}
// But when the client does NOT own the .com, the .com upgrade + any TLD still flags.
const aiIdx = buildIndex([{ domain: "zephr.ai", sld: "zephr", tld: "ai", clients: ["Zephr"] }], new Set());
ok("T1 flag zephr.com (owns .ai, .com is the upgrade)", !!matchCandidate(cand("zephr.com"), aiIdx));
ok("T1 flag zephr.xyz (no .com owned → not suppressed)", !!matchCandidate(cand("zephr.xyz"), aiIdx));
// T2 — owns howie.com, so .com affix variations are NOISE → NO flag (Rob's rule)
for (const d of ["gethowie.com", "howieapp.com", "tryhowie.com", "howiehq.com"]) {
  ok(`no flag ${d} (own .com → affix noise)`, matchCandidate(cand(d), idx) === null);
}
// T2 — when the client owns only a NON-.com, a .com affix variation still flags.
ok("T2 flag getzephr.com (owns .ai only)", !!matchCandidate(cand("getzephr.com"), aiIdx) && matchCandidate(cand("getzephr.com"), aiIdx)!.best_tier === "affix");
// Excluded — affix on non-.com → NO flag (affixes are .com-only regardless)
for (const d of ["gethowie.io", "howieapp.co", "tryhowie.ai"]) {
  ok(`no flag ${d} (affix non-.com)`, matchCandidate(cand(d), idx) === null);
}
// Excluded — the exact domain they already own → NO flag
ok("no flag howie.com (already owned)", matchCandidate(cand("howie.com"), idx) === null);
// Excluded — unrelated → NO flag
ok("no flag zebra.com", matchCandidate(cand("zebra.com"), idx) === null);
// Noise guard — ≤3-char anchor (go.com) must not flag go.io / getgo.com
ok("guard: no flag go.io", matchCandidate(cand("go.io"), idx) === null);
ok("guard: no flag getgo.com", matchCandidate(cand("getgo.com"), idx) === null);
// Noise guard — dictionary anchor (market.com) must not flag market.io / getmarket.com
ok("guard: no flag market.io", matchCandidate(cand("market.io"), idx) === null);
ok("guard: no flag getmarket.com", matchCandidate(cand("getmarket.com"), idx) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
