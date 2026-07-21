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
  // Domain auction / drop-catch / aftermarket blast senders — their emails are lists
  // of names for sale, NOT client conversations. Never ingest as a client.
  "namejet.com", "catches.io", "dropcatch.com", "snapnames.com", "sav.com", "park.io",
  "dynadot.com", "namesilo.com", "porkbun.com", "spaceship.com", "atom.com", "squadhelp.com",
  "brandbucket.com", "efty.com", "expireddomains.net", "gname.com", "west.cn", "epik.com",
  "domainagents.com", "undeveloped.com", "hugedomains.com", "flippa.com", "namepros.com",
]);

// A sender we should NEVER attribute a client/domain to — a marketplace/auction/
// automated blast, or a no-reply/notification robot. `email` is a bare address.
export function isBulkSender(email: string): boolean {
  const e = String(email || "").toLowerCase();
  const at = e.indexOf("@");
  if (at < 0) return false;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (isIgnoredDomain(domain)) return true; // marketplace / auction / infra / free-mail
  if (/^(no-?reply|do-?not-?reply|notif|notification|alerts?|auctions?|marketplace|support|sales|info|admin|mailer|bounce|postmaster|newsletter|updates?|team)$/.test(local)) return true;
  if (/namejet|catches|dropcatch|snapnames|auction|expired|backorder|aftermarket/.test(domain)) return true;
  return false;
}

// The email is genuinely about a domain TRANSACTION (buy-side / neutral), so a domain
// it names is a real target — not a domain merely mentioned in a donation, PR pitch,
// newsletter, or signature. Sell-side offers are gated separately (looksSellIntent).
// Used to decide whether to harvest domains from a mailbox message at all.
const DEAL_SIGNAL = /\b(buy(?:ing)?|purchas\w+|acquir\w+|acquisition|(?:make|made|submit)\s+(?:an?|you|a serious)\s+offer|asking price|your price|buy[-\s]?it[-\s]?now|\bBIN\b|interested in (?:buying|acquiring|purchasing|the domain)|domain (?:inquiry|purchase|acquisition|of interest)|inquir(?:y|e|ing) about|would like to (?:buy|acquire|purchase)|valuation|apprais\w+|escrow|willing to pay|our budget|the domain name)\b/i;
export function looksDomainDeal(text: string): boolean {
  return DEAL_SIGNAL.test(String(text || ""));
}

// The sender is offering to SELL us a domain (incl. the contact form's "Acquire or
// Sell?: Sell"). We track domains a client OWNS or is HUNTING to BUY — never a seller's
// unsolicited offer — so an email with sell intent is skipped entirely by the sweep.
const SELL_SIGNAL = /\b(look(?:ing)? to sell|want(?:ing)? to sell|(?:i'?m|i am|we'?re|we are) sell\w+|sell(?:ing)? (?:my|our|the|this) domain|(?:my|our|the|this) domains?(?:'?s| is| are)? (?:for sale|available|on the market)|for sale by owner|make me an offer|entertain(?:ing)? offers|open to (?:offers|selling)|acquire or sell\??\s*:?\s*sell)\b/i;
export function looksSellIntent(text: string): boolean {
  return SELL_SIGNAL.test(String(text || ""));
}

// Junk / non-human client labels to drop entirely (a person's name is required).
const JUNK_CLIENT = /^(reminder|reminders|n\/?a|none|unknown|test|noreply|no-reply|do-not-reply|notification|auction|marketplace|snapshot|snagged master txns|snagged|admin|sales|support|info|team)$/i;

// Bulk-sender / marketplace / auction ORG names — these appear as email DISPLAY
// names ("Catches.io", "NameJet", "DropCatch") so they must be dropped even when
// they carry a suffix (a bare `^catches$` never matched "Catches.io"). Word-ish
// substring match, case-insensitive.
const BULK_LABEL = /\b(namejet|catches|dropcatch|drop ?catch|snapnames|snap ?names|dynadot|namesilo|namecheap|godaddy|go ?daddy|afternic|sedo|porkbun|spaceship|hugedomains|huge ?domains|epik|squadhelp|brandbucket|efty|flippa|namepros|expireddomains|expired ?domains|backorder|aftermarket|no-?reply|do-?not-?reply|notification|newsletter|mailer|postmaster|mailer-?daemon|marketplace|auctions?)\b/i;

// Is a sender DISPLAY NAME a marketplace/auction blast ("Catches.io", "NameJet")?
// These blast from arbitrary mailer domains, so the from-ADDRESS check (isBulkSender)
// misses them — the display name is the tell. Used to skip such emails entirely.
export function isBulkClientName(name: string | null | undefined): boolean {
  return BULK_LABEL.test(String(name || "").trim());
}

/**
 * Clean a client/contact label to a real human name, or null to drop it:
 *  - drop email addresses (Rob wants names, not addresses)
 *  - drop bare domain-like tokens ("Catches.io") and bulk-sender org names
 *  - drop junk / automated / marketplace labels
 *  - trim + collapse whitespace
 */
export function cleanClientLabel(raw: string | null | undefined): string | null {
  let s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  if (s.includes("@")) return null; // an email address, not a name
  s = s.replace(/^["']|["']$/g, "").trim();
  if (!s || s.length < 2) return null;
  if (JUNK_CLIENT.test(s)) return null;
  if (BULK_LABEL.test(s)) return null; // a marketplace/auction org, not a client
  if (/^[a-z0-9][a-z0-9-]*\.[a-z]{2,}$/i.test(s)) return null; // a bare domain ("Catches.io"), not a person
  if (/^\d[\d.,/-]*$/.test(s)) return null; // a number/date, not a name
  return s;
}

// Our own team — an internal OWNER/handler, not a client.
const INTERNAL = /^(rob|rob schutz|robert schutz|brian|brian jarcho|sam|sam ?\w*|snagged)$/i;
export function isInternalOwner(label: string): boolean {
  return INTERNAL.test(String(label || "").trim());
}

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
