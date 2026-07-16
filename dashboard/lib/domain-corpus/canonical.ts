// Domain canonicalization + extraction for the Client Domain corpus builder.
// No PSL dependency (the dashboard has none — see lib/leads.ts / sales-comps for
// the same naive first-dot house pattern); we cover the common multi-label TLDs
// explicitly and otherwise treat the last two labels as the registrable apex.
//
// Everything here is pure + synchronous so the builder can canonicalize thousands
// of upstream cells without I/O.

// Recognized TLDs. All two-letter ccTLDs are accepted implicitly; this set adds the
// common multi-char gTLDs we actually see. A "domain" whose TLD isn't recognized is
// rejected (spec §4: reject domains without a recognized TLD).
const GTLDS = new Set([
  "com", "net", "org", "io", "co", "ai", "app", "dev", "xyz", "info", "biz", "me",
  "tv", "cc", "us", "uk", "ca", "au", "de", "fr", "es", "it", "nl", "eu", "in",
  "site", "online", "store", "shop", "tech", "cloud", "digital", "agency", "studio",
  "design", "media", "news", "blog", "live", "life", "world", "today", "group",
  "company", "solutions", "services", "systems", "network", "email", "team", "works",
  "ventures", "capital", "fund", "money", "finance", "financial", "bank", "trade",
  "market", "marketing", "global", "international", "care", "health", "clinic", "law",
  "legal", "realty", "estate", "homes", "house", "properties", "rentals", "travel",
  "tours", "games", "game", "fun", "art", "photo", "photography", "video", "audio",
  "music", "film", "fashion", "beauty", "fitness", "coach", "guru", "expert", "pro",
  "vip", "club", "social", "chat", "community", "network", "link", "click", "page",
  "website", "wtf", "lol", "ninja", "rocks", "cool", "wiki", "space", "zone", "one",
  "plus", "top", "best", "deals", "sale", "buy", "gift", "gifts", "toys", "kids",
  "baby", "pet", "pets", "dog", "cat", "food", "cafe", "bar", "pub", "kitchen",
  "recipes", "menu", "restaurant", "coffee", "beer", "wine", "vodka", "pizza",
  "energy", "solar", "eco", "green", "farm", "garden", "flowers", "land", "city",
  "town", "africa", "asia", "nyc", "london", "berlin", "paris", "vegas", "miami",
  "capetown", "quebec", "tokyo", "istanbul", "moscow", "school", "education", "academy",
  "university", "college", "institute", "training", "courses", "degree", "mba",
  "science", "engineering", "software", "computer", "systems", "data", "network",
  "hosting", "domains", "codes", "code", "sh", "gg", "to", "ly", "st", "so", "fm",
]);

// Second-level TLDs (the label immediately under the ccTLD is part of the suffix).
// Enough to keep the common ones (co.uk, com.au …) whole; anything else falls back
// to "last two labels".
const SLD_TLDS = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "co.nz", "net.nz", "org.nz", "co.za", "org.za",
  "com.br", "net.br", "org.br", "co.jp", "or.jp", "ne.jp", "co.in", "net.in",
  "org.in", "co.il", "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
  "com.cn", "com.ua", "co.kr", "co.id", "co.th", "com.ph", "com.my", "com.co",
]);

// Domains that should never enter the corpus — free-mail, infra, social /
// scheduling / comms platforms, and our own operational domains (spec §13).
const IGNORE = new Set([
  // free mail / personal inbox
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me",
  "protonmail.com", "gmx.com", "gmx.net", "mail.com", "zoho.com", "yandex.com",
  "fastmail.com", "hey.com", "pm.me", "comcast.net", "verizon.net", "att.net",
  "sbcglobal.net", "cox.net", "bellsouth.net", "charter.net", "earthlink.net",
  // our own
  "snagged.com", "snagged.co",
  // mail / infra / trackers
  "googlegroups.com", "google.com", "gstatic.com", "googleusercontent.com",
  "sentry.io", "amazonaws.com", "cloudfront.net", "sendgrid.net", "mailgun.org",
  "mailchimp.com", "mcsv.net", "list-manage.com", "hubspot.com", "hubspotemail.net",
  "hs-sites.com", "hubspotlinks.com", "constantcontact.com", "sparkpostmail.com",
  "bounce.com", "bounces.google.com", "postmarkapp.com", "mandrillapp.com",
  "sendgrid.com", "sendgrid.me", "amazonses.com", "email.amazonses.com",
  // social / scheduling / comms / SaaS platforms
  "facebook.com", "fb.com", "instagram.com", "twitter.com", "x.com", "t.co",
  "linkedin.com", "lnkd.in", "youtube.com", "youtu.be", "tiktok.com", "reddit.com",
  "pinterest.com", "snapchat.com", "whatsapp.com", "telegram.org", "discord.com",
  "discord.gg", "slack.com", "calendly.com", "cal.com", "zoom.us", "meet.google.com",
  "docs.google.com", "drive.google.com", "notion.so", "airtable.com", "typeform.com",
  "docusign.net", "docusign.com", "hellosign.com", "dropbox.com", "wetransfer.com",
  "github.com", "gitlab.com", "bitly.com", "bit.ly", "medium.com", "substack.com",
  "wordpress.com", "wix.com", "squarespace.com", "godaddy.com", "afternic.com",
  "sedo.com", "dan.com", "namecheap.com", "escrow.com", "paypal.com", "stripe.com",
  "venmo.com", "wise.com", "payoneer.com", "quickbooks.com", "intuit.com",
]);

/** Strip scheme / path / user / port / angle brackets and lowercase. */
function bareHost(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^<|>$/g, "");
  s = s.replace(/^[a-z][a-z0-9+.\-]*:\/\//, ""); // scheme://
  s = s.replace(/^mailto:/, "");
  const at = s.lastIndexOf("@"); // email → host part
  if (at >= 0) s = s.slice(at + 1);
  s = s.split(/[/?#\\]/)[0]; // path/query/fragment
  s = s.split(":")[0]; // port
  s = s.replace(/\.+$/, ""); // trailing dots
  s = s.replace(/^\.+/, "");
  return s;
}

/** Split a host into { sld, tld, apex } at the registrable boundary, or null. */
export function splitApex(host: string): { sld: string; tld: string; apex: string } | null {
  const h = bareHost(host);
  if (!h || !h.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(h)) return null; // reject IDN / junk for now
  const labels = h.split(".").filter(Boolean);
  if (labels.length < 2) return null;

  // Multi-label public suffix (co.uk) → keep three labels as the apex.
  const lastTwo = labels.slice(-2).join(".");
  let tld: string;
  let apexLabels: string[];
  if (SLD_TLDS.has(lastTwo) && labels.length >= 3) {
    tld = lastTwo;
    apexLabels = labels.slice(-3);
  } else {
    tld = labels[labels.length - 1];
    apexLabels = labels.slice(-2);
  }

  // Recognized TLD gate: the final label must be a known gTLD or a 2-letter ccTLD.
  const finalLabel = labels[labels.length - 1];
  if (!GTLDS.has(finalLabel) && !/^[a-z]{2}$/.test(finalLabel)) return null;

  const sld = apexLabels[0];
  if (!sld || sld.length < 1) return null;
  if (/^-|-$/.test(sld)) return null; // leading/trailing hyphen
  const apex = apexLabels.join(".");
  return { sld, tld, apex };
}

/** Canonical apex for a single host/URL/email, or null if it isn't a valid domain. */
export function canonicalApex(raw: string): string | null {
  const parts = splitApex(raw);
  return parts ? parts.apex : null;
}

/** Should this apex be excluded from the corpus? (free-mail / infra / social / ours) */
export function isIgnoredDomain(apex: string): boolean {
  const a = apex.toLowerCase();
  if (IGNORE.has(a)) return true;
  // also ignore anything whose apex sits under an ignored apex was already reduced;
  // a bare numeric or single-char SLD is noise.
  const sld = a.split(".")[0];
  if (/^\d+$/.test(sld)) return true;
  return false;
}

// Domain-like token scanner. Matches labels.tld with an optional path we discard.
// Deliberately liberal — every hit is re-validated through splitApex().
const DOMAIN_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\b/gi;

/**
 * Extract every canonical apex from a free-text cell / message body.
 * Falls back to treating the whole trimmed cell as one candidate if the regex finds
 * nothing but the cell itself looks like a bare domain (spec §5). Ignored/invalid
 * domains are dropped. Returns a de-duped list preserving first-seen order.
 */
export function extractApexes(text: string): string[] {
  const s = String(text || "");
  if (!s.trim()) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (apex: string | null) => {
    if (!apex) return;
    if (isIgnoredDomain(apex)) return;
    if (seen.has(apex)) return;
    seen.add(apex);
    out.push(apex);
  };

  let m: RegExpExecArray | null;
  DOMAIN_RE.lastIndex = 0;
  let found = false;
  while ((m = DOMAIN_RE.exec(s)) !== null) {
    found = true;
    push(canonicalApex(m[1]));
  }
  if (!found) {
    // Whole-cell fallback: "EM1.com monthly" style already handled by the regex;
    // this catches an odd single token the regex boundary missed.
    push(canonicalApex(s.trim().split(/\s+/)[0] || ""));
  }
  return out;
}
