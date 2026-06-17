// Per-domain marketplace deal activity, reconstructed from the deal mailboxes.
// SELL-SIDE ONLY: this is for domains we REPRESENT FOR SALE (the snagged.com
// marketplace listings). The three buckets are all buyer-facing:
//   • inbound  — buyers reaching out about our listed domain (contact-form
//                submissions + broker-forwarded inquiries + direct emails)
//   • pitched  — us proactively pitching the listed domain to a prospective buyer
//   • active   — any of the above with a real two-way human exchange
// Buy-side acquisition outreach (us pitching an owner to sell to US) is a
// different thing and must never be counted here — callers gate this to the
// marketplace for-sale inventory.
//
// Validated against live mail (person.com → 49 inbound; refresh.ai → 10 inbound
// + a 46-msg Efty negotiation). Read-only; see lib/gmail.ts.

import { dealMailboxes, getThread, searchThreadIds, type GmailMessage } from "./gmail";
import { findPitchExercises, type PitchExercise } from "./marketplace-pitch-sheets";
import { classifyMessageIds, hubspotConfigured, normMid, recipientEngagementForDomain, type HubspotEmail, type RecipientEngagement } from "./hubspot";

const isUs = (a: string) => a.endsWith("@snagged.com") || a.endsWith("@snagged.co");

// Marketplace BROKERS / platforms (GoDaddy + its Afternic arm). They FORWARD
// buyer inquiries and run their own outreach (e.g. "Afternic Sales", Jason
// Villalobos @ GoDaddy) — but the broker is NOT the buyer, so they're suppressed
// as a counterparty everywhere: they never occupy a row or a count. A real buyer
// the broker forwards still surfaces (from the form / forwarded headers); a
// broker-only thread with no underlying buyer is dropped as noise.
const BROKER_DOMAINS = ["godaddy.com", "afternic.com"];

// System/automation senders that are never a human counterparty. Form
// notifications are DELIVERED by some of these (zapiermail/superhuman/
// marketplace@) but their bodies are the structured submission — we still parse
// those; this set only governs who counts as a real "them" human, and lets a
// thread that is purely automated (no form, no human) be dropped as noise.
// escrow.com + docusign are transactional, not buyers — kept out of the buyer
// buckets here; their meaning (sale status / representation start) is detected
// separately below.
const SYSTEM_DOMAINS = ["asana.com", "zapiermail.com", "googlemail.com", "mailer-daemon", "superhuman.com", "cloudflare.com", "docusign.net", "docusign.com", "escrow.com", "intercom",
  // CRM / tracking / internal tooling — never a buyer counterparty.
  "hubspot.com", "docs.google.com", "domainscout", "calendly.com", "notion.so"];
// A negotiation with no activity in this many days is treated as STALE, not active.
const ACTIVE_DAYS = 45;
// Buyer signalling they're out — so the thread isn't a live negotiation.
const DECLINE = /\b(not interested|no longer interested|we'?ll pass|i'?ll pass|gonna pass|going to pass|decided (?:not|against)|no thank|out of (?:our )?budget|too (?:high|expensive|much)|can'?t afford|different direction|move on|no deal|withdraw)\b/i;
const SYSTEM_ADDRS = new Set(["sharing@superhuman.com", "reminder@superhuman.com", "noreply@snagged.com", "no-reply@snagged.com", "marketplace@snagged.com"]);
function isSystem(addr: string, name = ""): boolean {
  if (SYSTEM_ADDRS.has(addr)) return true;
  if (SYSTEM_DOMAINS.some((d) => addr.includes(d))) return true;
  if (BROKER_DOMAINS.some((d) => addr.endsWith("@" + d) || addr.endsWith("." + d))) return true;
  if (/via asana/i.test(name)) return true;
  return false;
}
const NEWSLETTER_HINT = ["newsletter", "mailchimp", "list-manage"];
// Conversations whose subject is structurally noise (internal tooling / infra /
// our own outbound research notifications), never a buyer deal.
const NOISE_SUBJECT = /(ownership report|new comment on:|new shared task|unread notifications|delivery status notification|did you forget to send|update nameservers|now active on cloudflare)/i;
const FREE_EMAIL = new Set(["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "qq.com", "proton.me", "protonmail.com", "icloud.com", "aol.com", "live.com", "mail.com", "163.com", "126.com", "yandex.com", "gmx.com"]);

function normSubject(s: string): string {
  s = (s || "").replace(/\[[^\]]*\]/g, " ");
  let prev: string;
  do { prev = s; s = s.replace(/^\s*(re|fwd|fw)\s*:\s*/i, ""); } while (s !== prev);
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}
const sld = (d: string) => d.split(".")[0];

type Form = { domain: string; name: string; email: string; budget: string; offer: string; message: string; intent: string };
// Parse a structured inquiry-form body. Handles all three historical formats:
// marketplace@ / newer Zapier ("Domain Name: X.com") and the older Superhuman/
// Zapier "New Submission" ("Domains: opson", often no TLD, with "Acquire or Sell?").
function parseForm(m: GmailMessage): Form | null {
  const b = m.body;
  // Two on-the-wire shapes: "Field: value" (marketplace@/Zapier/Superhuman) and
  // the Efty "*Field*\nvalue" markdown shape (legacy lead channel, still live).
  const field = (k: string): string => {
    const inline = b.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im"));
    if (inline?.[1]?.trim()) return inline[1].trim();
    const block = b.match(new RegExp(`^\\s*\\*?${k}\\*?\\s*\\r?\\n+\\s*(.+)$`, "im")); // Efty
    return block?.[1]?.trim() || "";
  };
  const dnRaw = field("Domain Name") || field("Domains") || field("Domain");
  if (!dnRaw) return null;
  const offer = field("Offer"); // Efty's structured buyer-offer field
  return {
    domain: dnRaw.toLowerCase().replace(/^www\./, "").split(/[\s,]+/)[0],
    name: (field("Name") || m.fromName || "").slice(0, 60),
    email: (field("Email") || "").slice(0, 80),
    budget: field("Budget").slice(0, 40), // a budget BAND (marketplace form)
    offer: offer && offer !== "-" && /\d/.test(offer) ? offer.slice(0, 40) : "", // a specific $ offer (Efty)
    message: field("Message").slice(0, 400),
    intent: field("Acquire or Sell\\?").slice(0, 30),
  };
}
// A form names our domain if its field equals the domain, or its SLD matches
// (the "Domains: opson" no-TLD format).
const formMatches = (f: Form, domain: string) => f.domain === domain || f.domain === sld(domain) || sld(f.domain) === sld(domain);

const hasBudget = (b?: string) => !!b && !/^(i'?m not sure|not sure|unsure|n\/?a|-|)$/i.test(b.trim());

export type DealThread = {
  subject: string;
  origin: "inbound" | "pitched";
  active: boolean; // live two-way negotiation (recent, not declined/stale)
  stale: boolean; // a real two-way thread that's gone quiet (> ACTIVE_DAYS)
  declined: boolean; // buyer signalled they're out
  hasForm: boolean;
  qualified: boolean; // a credible buyer (real budget / business email / engaged)
  // True two-way exchange: the buyer sent a message AFTER our first reply — i.e.
  // they engaged in a back-and-forth, not just submitted a form and went silent.
  // (For a pitched thread: they replied to our outreach.)
  repliedAfterUs: boolean;
  // For pitched threads only: was the outreach a cold mass send (HubSpot
  // sequence) or an individual 1:1 pitch? null for inbound. Sourced from the
  // HubSpot CRM email log (hs_sequence_id), heuristic fallback when not logged.
  pitchKind: "mass" | "individual" | null;
  // The HubSpot sequence/campaign name behind a mass pitch (e.g. "Domain Owner
  // Initial Outreach Sequence"), when known. null for 1:1 / inbound / unlogged.
  sequenceName: string | null;
  // HubSpot send-engagement for OUR outreach to this party (pitched threads):
  // count of our sends opened / clicked / replied-to. null when not in HubSpot.
  opens: number | null;
  clicks: number | null;
  replies: number | null;
  party: string;
  partyEmail: string | null;
  budget: string | null; // a budget BAND from the form ("$5K to $25K")
  offer: string | null; // a specific offer amount ("$50,000") — LLM > structured
  intent: string | null;
  outcome: string | null; // one-line "what happened" (LLM recap)
  messages: number;
  first: string; // YYYY-MM-DD
  last: string;
  lastSnippet: string;
};

// Normalize a structured offer string to a "$X" display (e.g. "5000" → "$5,000").
// We deliberately do NOT scrape free-text $ amounts from bodies — those pick up
// the ASK price we quote, not the buyer's offer. Real negotiated offers come from
// the LLM recap pass; this is the reliable structured (Efty) offer only.
function formatOffer(raw?: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  return `$${Number(digits).toLocaleString()}`;
}

// Sale status from Escrow.com — where actual marketplace sales settle. Stages
// progress: opened → terms agreed → payment secured → sold (closing statement /
// disbursement). NOT a buyer bucket — it's the outcome.
export type SaleStage = "opened" | "agreed" | "payment_secured" | "sold";
export type SaleStatus = {
  stage: SaleStage;
  label: string;
  opened: string | null; // YYYY-MM-DD
  closed: string | null; // set once sold
  txn: string | null;
};

export type DealReport = {
  domain: string;
  inbound: number;
  inboundQualified: number;
  // Qualified inbound that became a real back-and-forth (buyer replied after our
  // reply) — the "X actually responded after we did" number vs. form-and-gone.
  inboundEngaged: number;
  activeNegotiations: number;
  pitched: number;
  pitchedMass: number; // cold mass sends (HubSpot sequences)
  pitchedIndividual: number; // 1:1 outreach
  // How pitch type was determined: "hubspot" when the CRM email log was consulted
  // (authoritative), "heuristic" when it wasn't configured (Gmail-header fallback).
  // Doubles as the cache schema marker so pre-HubSpot reports rebuild.
  pitchSource: "hubspot" | "heuristic";
  // Cold outreach via HubSpot sequences — full audience + engagement, sourced
  // straight from HubSpot. null when HubSpot isn't configured.
  cold: ColdOutreach | null;
  // Naming-exercise pitches: this domain appearing in a client's pitch sheet.
  pitchExercises: PitchExercise[];
  // Owner engagement start, from the completed Snagged brokerage DocuSign.
  representingSince: string | null;
  // Sale outcome, from Escrow.com (null if never went to escrow).
  sale: SaleStatus | null;
  threads: DealThread[];
};

// Cold outreach (HubSpot sequences) — sourced directly from the HubSpot CRM email
// log (the FULL audience, not just threads in the deal mailboxes). One row per
// external recipient of a sequence naming this domain.
export type ColdRecipient = {
  party: string;
  email: string;
  sends: number;
  opened: boolean;
  clicked: boolean;
  replied: boolean; // they replied to our cold send
  responded: boolean; // replied OR became a two-way thread in the mailboxes
  // Emails in the back-and-forth with THIS recipient — the full thread length when
  // a deal-mailbox thread exists, else the count of our sequence steps they
  // replied to. The per-person drill-down behind the "responded" count.
  chain: number;
  active: boolean; // matching live two-way negotiation (recent, not declined)
  lastSent: string; // YYYY-MM-DD
  sequenceName: string | null;
  outcome: string | null; // from a matching deal-mailbox thread, when one exists
  offer: string | null;
};
export type ColdOutreach = {
  recipients: number;
  sends: number;
  opened: number; // # UNIQUE recipients who opened ≥1 send
  clicked: number; // # unique recipients who clicked
  replied: number; // # unique recipients who replied (never a sum of reply emails)
  responded: number; // # unique recipients who responded (replied OR two-way thread)
  active: number; // # that turned into a live negotiation
  rows: ColdRecipient[];
};

const SALE_RANK: Record<SaleStage, number> = { opened: 1, agreed: 2, payment_secured: 3, sold: 4 };
function escrowStage(subject: string): SaleStage | null {
  const s = subject.toLowerCase();
  if (/(closing statement|disbursement|domain name has been accepted|wait for merchandise)/.test(s)) return "sold";
  if (/payment secured/.test(s)) return "payment_secured";
  if (/agreed to terms/.test(s)) return "agreed";
  if (/(successfully created|transaction was successfully created|disbursement method)/.test(s)) return "opened";
  return null;
}
const SALE_LABEL: Record<SaleStage, string> = {
  opened: "In escrow (opened)", agreed: "Terms agreed", payment_secured: "Payment secured — in transfer", sold: "Sold",
};

// Detect the Escrow.com sale lifecycle for a domain (highest stage reached).
async function detectSale(domain: string): Promise<SaleStatus | null> {
  const seen = new Set<string>();
  const events: { stage: SaleStage; date: number; txn: string | null }[] = [];
  for (const mailbox of dealMailboxes()) {
    let tids: string[] = [];
    try { tids = await searchThreadIds(mailbox, `from:escrow.com "${domain}"`, 40); } catch { /* skip */ }
    for (const tid of tids) {
      let msgs: GmailMessage[];
      try { msgs = await getThread(mailbox, tid); } catch { continue; }
      for (const m of msgs) {
        if (seen.has(m.mid) || !m.from.includes("escrow.com")) continue;
        seen.add(m.mid);
        const stage = escrowStage(m.subject);
        if (!stage) continue;
        const txn = (m.subject.match(/#?(\d{6,})/) || [])[1] || null;
        events.push({ stage, date: m.date, txn });
      }
    }
  }
  if (!events.length) return null;
  events.sort((a, b) => a.date - b.date);
  const top = events.reduce((a, b) => (SALE_RANK[b.stage] >= SALE_RANK[a.stage] ? b : a));
  const sold = events.find((e) => e.stage === "sold");
  return {
    stage: top.stage,
    label: SALE_LABEL[top.stage],
    opened: ymd(events[0].date),
    closed: sold ? ymd(sold.date) : null,
    txn: top.txn || events.find((e) => e.txn)?.txn || null,
  };
}

// Representation start = the completed Snagged brokerage DocuSign envelope.
async function detectRepresentingSince(domain: string): Promise<string | null> {
  let earliest: number | null = null;
  for (const mailbox of dealMailboxes()) {
    let tids: string[] = [];
    try { tids = await searchThreadIds(mailbox, `from:docusign "snagged" "${domain}"`, 10); } catch { /* skip */ }
    for (const tid of tids) {
      let msgs: GmailMessage[];
      try { msgs = await getThread(mailbox, tid); } catch { continue; }
      for (const m of msgs) {
        if (!m.from.includes("docusign")) continue;
        if (!/snagged/i.test(m.subject) && !/snagged/i.test(m.body)) continue;
        if (earliest === null || m.date < earliest) earliest = m.date;
      }
    }
  }
  return earliest ? ymd(earliest) : null;
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Collect every message across the deal mailboxes that could relate to `domain`,
// reconstructing FULL threads (so replies that didn't individually match are
// included), deduped by RFC Message-ID.
async function collect(domain: string): Promise<GmailMessage[]> {
  const queries = [`subject:"${domain}"`, `"${domain}"`];
  const seen = new Set<string>();
  const out: GmailMessage[] = [];
  for (const mailbox of dealMailboxes()) {
    const tids = new Set<string>();
    for (const q of queries) {
      try { (await searchThreadIds(mailbox, q, 120)).forEach((t) => tids.add(t)); } catch { /* keep going */ }
    }
    for (const tid of tids) {
      let msgs: GmailMessage[];
      try { msgs = await getThread(mailbox, tid); } catch { continue; }
      for (const m of msgs) {
        if (seen.has(m.mid)) continue;
        seen.add(m.mid);
        out.push(m);
      }
    }
  }
  return out;
}

// {name,email} pairs from a To/Cc header string.
function addrsIn(h: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  const re = /(?:"?([^"<>,]+?)"?\s*)?<?\s*([\w.\-+]+@[\w.\-]+)\s*>?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(h || ""))) out.push({ name: (m[1] || "").trim(), email: m[2].toLowerCase() });
  return out;
}
// Participants from FORWARDED message headers inside a body — "From: Name <email>"
// / "To: …". This is how a buyer surfaces when their reply was forwarded
// internally (Rob↔Brian) rather than landing as its own message.
function forwardedParticipants(body: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  const re = /^\s*(?:From|To)\s*:\s*(?:"?([^"<\n]+?)"?\s*)?<\s*([\w.\-+]+@[\w.\-]+)\s*>/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out.push({ name: (m[1] || "").trim(), email: m[2].toLowerCase() });
  return out;
}
// The real external counterparty (buyer): the most-seen address across every
// message's From, To/Cc, AND forwarded headers — excluding us, the seller, and
// system/automation. Returns null when there's no external human anywhere (a
// purely internal Rob↔Brian thread), so such threads get dropped.
// Normalized name key: lowercase, accent-stripped, punctuation-free, tokens
// sorted — so "Alberto Lopez" and "López, Alberto" collapse to the same key.
// Lets us catch a seller's OTHER email addresses (e.g. a work address) by name.
function nameKey(s: string): string {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter(Boolean).sort().join(" ");
}
function resolveExternalParty(ms: GmailMessage[], sellerEmails: Set<string>, sellerNameKeys: Set<string>): { name: string; email: string } | null {
  const count = new Map<string, number>();
  const names = new Map<string, string>();
  // The actual buyer SENDS messages; someone merely CC'd on a big thread does not.
  // So weight a From sender far above a To/Cc recipient — otherwise a person CC'd
  // on all 110 messages outranks the buyer who sent 50 (Luxe.com's Daniel Cox vs
  // Alyas). Forwarded "From" headers are historical senders → weighted too.
  const consider = (name: string, emailRaw: string, weight: number) => {
    const email = (emailRaw || "").toLowerCase();
    if (!email || isUs(email) || isSystem(email, name) || sellerEmails.has(email)) return;
    if (name && sellerNameKeys.has(nameKey(name))) return; // the seller under another address
    count.set(email, (count.get(email) || 0) + weight);
    if (name && !names.has(email)) names.set(email, name);
  };
  for (const m of ms) {
    consider(m.fromName, m.from, 10);
    for (const a of addrsIn(m.to)) consider(a.name, a.email, 1);
    for (const a of addrsIn(m.cc)) consider(a.name, a.email, 1);
    for (const a of forwardedParticipants(m.body)) consider(a.name, a.email, 5);
  }
  if (!count.size) return null;
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { name: names.get(top) || top.split("@")[0], email: top };
}

export async function buildDealReport(domain: string): Promise<DealReport> {
  domain = domain.toLowerCase().replace(/^www\./, "");
  const [msgs, sale, representingSince, pitchExercises, recipients] = await Promise.all([
    collect(domain),
    detectSale(domain),
    detectRepresentingSince(domain),
    findPitchExercises(domain).catch(() => [] as PitchExercise[]),
    recipientEngagementForDomain(domain).catch(() => [] as RecipientEngagement[]),
  ]);

  // Authoritative pitch-type classification from the HubSpot CRM email log:
  // join every collected message to its logged engagement by RFC Message-ID, so a
  // pitch sent via a sequence (mass) is told apart from a logged 1:1 (individual),
  // with the sequence name in hand. Best-effort — empty map ⇒ Gmail-header fallback.
  const hsByMid: Map<string, HubspotEmail> = await classifyMessageIds(msgs.map((m) => m.mid));
  // The full outbound audience for this domain (cold + 1:1), keyed by recipient
  // email — powers the cold roster and the per-thread engagement metrics.
  const engByEmail = new Map<string, RecipientEngagement>(recipients.map((r) => [r.email.toLowerCase(), r]));

  // Group into conversations by Gmail THREAD ID — the real conversation boundary.
  // Grouping by subject over-merged DISTINCT buyers who happened to get the same
  // pitch subject (e.g. Rob's "Strategic Opportunity: <domain>" sent to many
  // buyers all collapsed into one 135-msg blob, then resolved to one wrong party).
  // Messages are already deduped by Message-ID, so a conversation clusters under
  // its first-seen mailbox's threadId.
  const convos = new Map<string, GmailMessage[]>();
  for (const m of msgs) {
    const k = m.threadId || normSubject(m.subject);
    (convos.get(k) || convos.set(k, []).get(k)!).push(m);
  }

  // First pass — keep only convos actually about this domain, and tally each
  // external counterparty's distinct-thread count. The DOMAIN OWNER/SELLER recurs
  // across many of a domain's threads (forwarding offers, status, etc.) whereas a
  // buyer shows up in one — so a counterparty in ≥3 threads is treated as the
  // seller and excluded from the buyer buckets (e.g. Luxe.com's Alberto Lopez).
  type Relevant = { ms: GmailMessage[]; formMatch: Form[] };
  const relevant: Relevant[] = [];
  const threadsByEmail = new Map<string, number>();
  for (const [, ms] of convos) {
    ms.sort((a, b) => a.date - b.date);
    const subjects = ms.map((m) => normSubject(m.subject));
    if (NOISE_SUBJECT.test(subjects[subjects.length - 1])) continue; // tooling/infra thread
    const forms = ms.map(parseForm).filter((f): f is Form => !!f);
    const formMatch = forms.filter((f) => formMatches(f, domain));
    const subjHas = subjects.some((s) => s.includes(domain) || s.includes(sld(domain)));
    if (!formMatch.length && !subjHas) continue; // incidental mention only
    if (!formMatch.length && ms.some((m) => NEWSLETTER_HINT.some((h) => m.from.includes(h)))) continue;
    relevant.push({ ms, formMatch });
    for (const e of new Set(ms.filter((m) => !isUs(m.from) && !isSystem(m.from, m.fromName)).map((m) => m.from))) {
      threadsByEmail.set(e, (threadsByEmail.get(e) || 0) + 1);
    }
  }
  const sellerEmails = new Set([...threadsByEmail].filter(([, c]) => c >= 3).map(([e]) => e));
  // The seller often uses more than one address (e.g. a personal gmail AND a work
  // email) — collect the display-name keys of the identified seller(s) so their
  // OTHER addresses are excluded too (Luxe.com's Alberto: gmail ≥3 threads, plus a
  // 2-thread volvocars.com "López, Alberto" that the count alone would miss).
  const sellerNameKeys = new Set<string>();
  for (const m of msgs) if (sellerEmails.has(m.from) && m.fromName) sellerNameKeys.add(nameKey(m.fromName));
  sellerNameKeys.delete("");
  const isSellerName = (name: string) => !!name && sellerNameKeys.has(nameKey(name));
  const isBuyer = (m: GmailMessage) =>
    !isUs(m.from) && !isSystem(m.from, m.fromName) && !sellerEmails.has(m.from) && !isSellerName(m.fromName);

  const threads: DealThread[] = [];
  const transcripts: ThreadTranscript[] = []; // aligned 1:1 with threads, for the LLM recap
  for (const { ms, formMatch } of relevant) {
    const usMsgs = ms.filter((m) => isUs(m.from));
    const themMsgs = ms.filter(isBuyer); // real buyers only — seller excluded
    const hasForm = formMatch.length > 0;
    const hasUs = usMsgs.length > 0;
    const hasThem = themMsgs.length > 0;
    // The real external buyer — from From / To / Cc / forwarded headers (so a
    // buyer who only appears as a recipient or inside a forwarded reply still
    // counts), never us or the seller.
    const extParty = resolveExternalParty(ms, sellerEmails, sellerNameKeys);
    // No form AND no external buyer anywhere = a purely internal (Rob↔Brian) or
    // seller-only thread — not a buyer deal. Drop it.
    if (!hasForm && !extParty) continue;

    const firstHuman = ms.find((m) => isUs(m.from) || isBuyer(m));
    let origin: "inbound" | "pitched";
    if (hasForm || (firstHuman && !isUs(firstHuman.from))) origin = "inbound";
    else if (firstHuman && isUs(firstHuman.from)) origin = "pitched";
    else continue; // purely automated / seller-only → noise

    // Live vs stale vs declined. "Active negotiation" = a real two-way exchange
    // that is RECENT and not declined — a March inquiry with no reply since, or a
    // buyer who passed, is NOT active.
    const lastDate = ms[ms.length - 1].date;
    const stale = (Date.now() - lastDate) / 86400000 > ACTIVE_DAYS;
    const recentThem = themMsgs.slice(-2).map((m) => `${m.subject}\n${m.body}`).join("\n");
    const declined = DECLINE.test(recentThem);
    const active = hasUs && hasThem && !stale && !declined;
    // Real two-way: a buyer message dated after our FIRST reply (so they engaged
    // beyond the initial form / our cold pitch). active is recency-gated; this is
    // the all-time "did they ever respond after we did" signal.
    const firstUsDate = usMsgs.length ? usMsgs[0].date : Infinity;
    const repliedAfterUs = themMsgs.some((m) => m.date > firstUsDate);
    // Pitch type (pitched threads only). Prefer the HubSpot CRM email log: if any
    // of our sends in the thread was a sequence send → mass (carry its name);
    // else, if HubSpot logged any send 1:1 → individual. Fall back to the Gmail
    // header heuristic only when none of our sends are in the HubSpot log.
    let pitchKind: "mass" | "individual" | null = null;
    let sequenceName: string | null = null;
    if (origin === "pitched") {
      const hsSends = usMsgs.map((m) => hsByMid.get(normMid(m.mid))).filter((h): h is HubspotEmail => !!h && h.direction === "outbound");
      if (hsSends.length) {
        const seq = hsSends.find((h) => h.kind === "mass");
        pitchKind = seq ? "mass" : "individual";
        sequenceName = seq?.sequenceName || null;
      } else {
        pitchKind = usMsgs.some((m) => m.bulk) ? "mass" : "individual"; // fallback
      }
    }

    const fm = formMatch[0] || null;
    // Buyer identity: the form's contact, else the resolved external party
    // (From/To/Cc/forwarded). Never us or the seller.
    const party = (fm?.name || extParty?.name || "").trim();
    const partyEmail = fm?.email || extParty?.email || null;
    // HubSpot send-engagement for our outreach to this party (pitched threads).
    const eng = partyEmail ? engByEmail.get(partyEmail.toLowerCase()) : undefined;

    const emailDom = (partyEmail || "").split("@")[1]?.toLowerCase() || "";
    const qualified = hasBudget(fm?.budget) || (!!emailDom && !FREE_EMAIL.has(emailDom)) || ms.length >= 3 || (hasUs && hasThem);

    threads.push({
      subject: ms[ms.length - 1].subject,
      origin, active, stale, declined, hasForm, qualified, repliedAfterUs, pitchKind, sequenceName,
      opens: origin === "pitched" && eng ? eng.opened : null,
      clicks: origin === "pitched" && eng ? eng.clicked : null,
      replies: origin === "pitched" && eng ? eng.replied : null,
      party: party || "—",
      partyEmail,
      budget: fm && hasBudget(fm.budget) ? fm.budget : null,
      offer: formatOffer(fm?.offer),
      intent: fm?.intent || null,
      outcome: null,
      messages: ms.length,
      first: ymd(ms[0].date),
      last: ymd(ms[ms.length - 1].date),
      lastSnippet: ms[ms.length - 1].snippet.slice(0, 160),
    });
    transcripts.push(buildTranscript(ms, (m) => isUs(m.from)));
  }

  // LLM recap (best-effort, on demand) — fills each thread's one-line `outcome`
  // and the real negotiated `offer` (distinguishing a buyer offer from our ask).
  // Runs once per generation against the index-aligned transcripts BEFORE the
  // sort; the whole report is cached so page loads never pay for it. Fail-open.
  await applyRecaps(domain, threads, transcripts, process.env);

  // One row per buyer: a buyer can appear in a direct thread AND a forwarded
  // internal copy (now separate threadIds). Keep the richest thread per email,
  // OR-ing active and carrying any offer/outcome/extent.
  const best = new Map<string, DealThread>();
  for (const t of threads) {
    const key = (t.partyEmail || "").toLowerCase();
    if (!key) continue;
    const ex = best.get(key);
    const merge = (keep: DealThread, drop: DealThread) => {
      keep.active = keep.active || drop.active;
      keep.offer = keep.offer || drop.offer;
      keep.outcome = keep.outcome || drop.outcome;
      keep.qualified = keep.qualified || drop.qualified;
      keep.repliedAfterUs = keep.repliedAfterUs || drop.repliedAfterUs;
      // A marketplace form submission ANYWHERE means the buyer came to us first —
      // that's an inbound inquiry, even if we later pitched them in a separate
      // thread (which on its own looks "pitched"). Inbound wins, and we carry the
      // form's budget/intent onto the kept (richer) conversation.
      if (drop.origin === "inbound" || drop.hasForm) {
        keep.origin = "inbound";
        keep.hasForm = keep.hasForm || drop.hasForm;
        keep.budget = keep.budget || drop.budget;
        keep.intent = keep.intent || drop.intent;
        keep.pitchKind = null;
        keep.opens = keep.opens ?? drop.opens;
        keep.clicks = keep.clicks ?? drop.clicks;
        keep.replies = keep.replies ?? drop.replies;
      }
      // Prefer a mass classification (a sequence send anywhere makes the pitch mass)
      // and keep whichever side carries the sequence name — but only while the row
      // is still a pitch (an inbound form above overrides this).
      if (keep.origin === "pitched") {
        if (drop.pitchKind === "mass") keep.pitchKind = "mass";
        else keep.pitchKind = keep.pitchKind || drop.pitchKind;
        keep.sequenceName = keep.sequenceName || drop.sequenceName;
      }
      if (drop.last > keep.last) keep.last = drop.last;
      if (drop.first < keep.first) keep.first = drop.first;
    };
    if (!ex) best.set(key, t);
    else if (t.messages > ex.messages) { merge(t, ex); best.set(key, t); }
    else merge(ex, t);
  }
  const final = threads.filter((t) => {
    const key = (t.partyEmail || "").toLowerCase();
    return !key || best.get(key) === t;
  });

  final.sort((a, b) => (a.last < b.last ? 1 : -1));
  const pitchedThreads = final.filter((t) => t.origin === "pitched");

  // Cold-outreach bucket: the full HubSpot sequence audience for this domain,
  // enriched with any matching deal-mailbox thread (real outcome / live status).
  const threadByEmail = new Map<string, DealThread>();
  for (const t of final) {
    if (!t.partyEmail) continue;
    const k = t.partyEmail.toLowerCase();
    const ex = threadByEmail.get(k);
    if (!ex || t.messages > ex.messages) threadByEmail.set(k, t);
  }
  const cold: ColdOutreach | null = hubspotConfigured() ? buildCold(recipients, threadByEmail) : null;

  return {
    domain,
    inbound: final.filter((t) => t.origin === "inbound").length,
    inboundQualified: final.filter((t) => t.origin === "inbound" && t.qualified).length,
    inboundEngaged: final.filter((t) => t.origin === "inbound" && t.qualified && t.repliedAfterUs).length,
    activeNegotiations: final.filter((t) => t.active).length,
    pitched: pitchedThreads.length,
    pitchedMass: pitchedThreads.filter((t) => t.pitchKind === "mass").length,
    pitchedIndividual: pitchedThreads.filter((t) => t.pitchKind === "individual").length,
    pitchSource: hubspotConfigured() ? "hubspot" : "heuristic",
    cold,
    pitchExercises,
    representingSince,
    sale,
    threads: final,
  };
}

// Build the cold-outreach roster from the HubSpot sequence audience, enriching
// each recipient with the matching deal-mailbox thread (when a cold send turned
// into a real exchange). Responders sort to the top, then most-recently-sent.
function buildCold(recipients: RecipientEngagement[], threadByEmail: Map<string, DealThread>): ColdOutreach {
  const rows: ColdRecipient[] = recipients
    .filter((r) => r.kind === "mass")
    .map((r) => {
      const t = threadByEmail.get(r.email.toLowerCase());
      const replied = r.replied > 0;
      const responded = replied || !!(t && t.repliedAfterUs);
      return {
        party: (t && t.party !== "—" ? t.party : "") || r.name || r.email.split("@")[0],
        email: r.email,
        sends: r.sends,
        opened: r.opened > 0,
        clicked: r.clicked > 0,
        replied,
        responded,
        // Real conversation length when we have the thread, else the # of our
        // sends they replied to (0 when they never responded).
        chain: t ? t.messages : r.replied,
        active: !!(t && t.active),
        lastSent: ymd(r.lastSent),
        sequenceName: r.sequenceName,
        outcome: t?.outcome || null,
        offer: t?.offer || null,
      };
    })
    .sort((a, b) => (a.responded !== b.responded ? (a.responded ? -1 : 1) : a.lastSent < b.lastSent ? 1 : -1));
  return {
    recipients: rows.length,
    sends: rows.reduce((s, r) => s + r.sends, 0),
    opened: rows.filter((r) => r.opened).length,
    clicked: rows.filter((r) => r.clicked).length,
    replied: rows.filter((r) => r.replied).length,
    responded: rows.filter((r) => r.responded).length,
    active: rows.filter((r) => r.active).length,
    rows,
  };
}

// A compact transcript for the LLM recap: the last few messages, each tagged
// US/THEM, signature/quote-trimmed and capped. Keeps the LLM input small.
export type ThreadTranscript = { lines: string[] };
function buildTranscript(ms: GmailMessage[], us: (m: GmailMessage) => boolean): ThreadTranscript {
  const lines = ms.slice(-7).map((m) => {
    const who = us(m) ? "US" : (m.fromName || m.from || "THEM");
    // Drop quoted replies / signatures — keep the fresh text only.
    const body = m.body
      .split(/\n\s*(?:On .+ wrote:|-----Original Message-----|From: )/)[0]
      .replace(/^\s*>.*$/gm, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    return `${who}: ${body}`;
  });
  return { lines };
}

// Merge LLM recaps (offer + one-line outcome) into the threads in place. Aligned
// by index with `transcripts`. Best-effort: leaves threads as-is on any failure.
async function applyRecaps(domain: string, threads: DealThread[], transcripts: ThreadTranscript[], env: NodeJS.ProcessEnv): Promise<void> {
  try {
    const { recapThreads } = await import("./marketplace-deal-recaps");
    const items = threads.map((t, i) => ({
      idx: i, party: t.party, origin: t.origin,
      subject: t.subject, transcript: transcripts[i]?.lines.join("\n") || "",
    }));
    const recaps = await recapThreads(domain, items, env);
    for (const [i, r] of recaps) {
      const t = threads[i];
      if (!t) continue;
      if (r.outcome) t.outcome = r.outcome;
      if (r.offer) t.offer = r.offer; // LLM-extracted buyer offer beats the structured one
    }
  } catch {
    /* recaps are enrichment only — never block the report */
  }
}
