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

const isUs = (a: string) => a.endsWith("@snagged.com") || a.endsWith("@snagged.co");

// System/automation senders that are never a human counterparty. Form
// notifications are DELIVERED by some of these (zapiermail/superhuman/
// marketplace@) but their bodies are the structured submission — we still parse
// those; this set only governs who counts as a real "them" human, and lets a
// thread that is purely automated (no form, no human) be dropped as noise.
const SYSTEM_DOMAINS = ["asana.com", "zapiermail.com", "googlemail.com", "mailer-daemon", "superhuman.com", "cloudflare.com", "docusign.net", "docusign.com", "intercom"];
const SYSTEM_ADDRS = new Set(["sharing@superhuman.com", "reminder@superhuman.com", "noreply@snagged.com", "no-reply@snagged.com", "marketplace@snagged.com"]);
function isSystem(addr: string, name = ""): boolean {
  if (SYSTEM_ADDRS.has(addr)) return true;
  if (SYSTEM_DOMAINS.some((d) => addr.includes(d))) return true;
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

type Form = { domain: string; name: string; email: string; budget: string; message: string; intent: string };
// Parse a structured inquiry-form body. Handles all three historical formats:
// marketplace@ / newer Zapier ("Domain Name: X.com") and the older Superhuman/
// Zapier "New Submission" ("Domains: opson", often no TLD, with "Acquire or Sell?").
function parseForm(m: GmailMessage): Form | null {
  const b = m.body;
  const field = (k: string) => (b.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, "im"))?.[1] || "").trim();
  const dnRaw = field("Domain Name") || field("Domains") || field("Domain");
  if (!dnRaw) return null;
  return {
    domain: dnRaw.toLowerCase().replace(/^www\./, "").split(/[\s,]+/)[0],
    name: (field("Name") || m.fromName || "").slice(0, 60),
    email: (field("Email") || "").slice(0, 80),
    budget: field("Budget").slice(0, 40),
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
  active: boolean;
  hasForm: boolean;
  qualified: boolean; // a credible buyer (real budget / business email / engaged)
  party: string;
  partyEmail: string | null;
  budget: string | null;
  intent: string | null;
  messages: number;
  first: string; // YYYY-MM-DD
  last: string;
  lastSnippet: string;
};

export type DealReport = {
  domain: string;
  inbound: number;
  inboundQualified: number;
  activeNegotiations: number;
  pitched: number;
  threads: DealThread[];
};

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

export async function buildDealReport(domain: string): Promise<DealReport> {
  domain = domain.toLowerCase().replace(/^www\./, "");
  const msgs = await collect(domain);

  // Group into conversations by normalized subject (merges cross-mailbox dupes,
  // the form notification, and all replies).
  const convos = new Map<string, GmailMessage[]>();
  for (const m of msgs) {
    const k = normSubject(m.subject);
    (convos.get(k) || convos.set(k, []).get(k)!).push(m);
  }

  const threads: DealThread[] = [];
  for (const [key, ms] of convos) {
    if (NOISE_SUBJECT.test(key)) continue;
    ms.sort((a, b) => a.date - b.date);

    const forms = ms.map(parseForm).filter((f): f is Form => !!f);
    const formMatch = forms.filter((f) => formMatches(f, domain));
    const subjHas = key.includes(domain) || key.includes(sld(domain));
    if (!formMatch.length && !subjHas) continue; // incidental mention only

    // Skip pure newsletter blasts (no form, not an actual inquiry thread).
    if (!formMatch.length && ms.some((m) => NEWSLETTER_HINT.some((h) => m.from.includes(h)))) continue;

    const senders = new Set(ms.map((m) => m.from));
    const usMsgs = ms.filter((m) => isUs(m.from));
    const themMsgs = ms.filter((m) => !isUs(m.from) && !isSystem(m.from, m.fromName));
    const hasForm = formMatch.length > 0;
    const hasUs = usMsgs.length > 0;
    const hasThem = themMsgs.length > 0;

    const firstHuman = ms.find((m) => isUs(m.from) || !isSystem(m.from, m.fromName));
    let origin: "inbound" | "pitched";
    if (hasForm || (firstHuman && !isUs(firstHuman.from))) origin = "inbound";
    else if (firstHuman && isUs(firstHuman.from)) origin = "pitched";
    else continue; // purely automated, no form, no human → noise

    const active = hasUs && hasThem;
    const fm = formMatch[0] || null;
    // Party: the buyer. From the form (name/email) for inbound submissions;
    // the external human for direct threads; the To: recipient for our pitches.
    let party = (fm?.name || themMsgs[0]?.fromName || themMsgs[0]?.from || "").trim();
    let partyEmail = fm?.email || themMsgs[0]?.from || null;
    if (origin === "pitched" && !party) {
      const to = usMsgs[0]?.to || "";
      party = (to.match(/"?([^"<]+?)"?\s*</)?.[1] || bareAddrToName(to)).trim();
      partyEmail = (to.match(/[\w.\-+]+@[\w.\-]+/)?.[0] || null);
    }

    // Qualified buyer heuristic: a real budget band, OR a business (non-free)
    // email, OR a genuinely engaged thread (multi-message back-and-forth).
    const emailDom = (partyEmail || "").split("@")[1]?.toLowerCase() || "";
    const qualified = hasBudget(fm?.budget) || (!!emailDom && !FREE_EMAIL.has(emailDom)) || ms.length >= 3 || active;

    threads.push({
      subject: ms[ms.length - 1].subject,
      origin, active, hasForm, qualified,
      party: party || "—",
      partyEmail,
      budget: fm && hasBudget(fm.budget) ? fm.budget : null,
      intent: fm?.intent || null,
      messages: ms.length,
      first: ymd(ms[0].date),
      last: ymd(ms[ms.length - 1].date),
      lastSnippet: ms[ms.length - 1].snippet.slice(0, 160),
    });
    void senders;
  }

  threads.sort((a, b) => (a.last < b.last ? 1 : -1));
  return {
    domain,
    inbound: threads.filter((t) => t.origin === "inbound").length,
    inboundQualified: threads.filter((t) => t.origin === "inbound" && t.qualified).length,
    activeNegotiations: threads.filter((t) => t.active).length,
    pitched: threads.filter((t) => t.origin === "pitched").length,
    threads,
  };
}

function bareAddrToName(s: string): string {
  const a = s.match(/[\w.\-+]+@[\w.\-]+/)?.[0] || "";
  return a ? a.split("@")[0] : "";
}
