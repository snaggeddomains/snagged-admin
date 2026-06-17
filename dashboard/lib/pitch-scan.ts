// Weekly pitch-scan: read the owner's SENT mail, find outbound domain pitches
// (us emailing an external person and naming one of our domains in the subject),
// and surface the ones NOT already tracked on a pitch-exercise sheet — so they
// can be added. Delivered as an email digest (see api/cron/pitch-scan).
//
// Detection is subject-anchored on purpose (high precision): Rob's pitch threads
// are titled with the domain ("Re: particle.ai", "Re: Grow.com", "Factorial.com")
// and go to an external recipient. System/automation notifications (EPP status,
// expiration, payment, newsletter) are filtered out, and internal/self mail is
// dropped by requiring a real external recipient.

import { searchMessages, getMessage, type GmailMessage } from "./gmail";
import { allExerciseDomains } from "./marketplace-pitch-sheets";

// The mailbox we scan — the owner who sends the pitches. Override via env.
const PITCH_MAILBOX = process.env.PITCH_SCAN_MAILBOX || "rob@snagged.com";
const isUs = (a: string) => /@snagged\.(com|co)$/i.test(a);
// Same broker/system suppression spirit as the deal report — never a real pitch
// target, and the automated status/billing notifications Gmail files under Sent.
const SYSTEM_RECIPIENT = /@(godaddy|afternic|escrow|docusign|asana|superhuman|zapiermail|mailchimp|intercom|calendly|notion|hubspot)\b/i;
// Inbound lead notifications, deal-execution, and automation that get filed in
// Sent (we REPLIED to them) — none are an outbound pitch to ADD to a sheet.
const NOISE_SUBJECT = /(epp status|status codes changed|expiration date changed|name ?servers? changed|now active on cloudflare|payment received|invoice|new newsletter subscriber|delivery status|out of office|auto[- ]?reply|read receipt|unsubscribe|update nameservers|new submission from|contact - new submission|\[snagged\.com\]|purchase agreement|authorization code|invitation:|document shared|domain jam|\bcontract\b)/i;
// Free-mail + our own domain: when these turn up as the "subject domain" they're
// almost always a recipient address scraped out of an inbound-form subject, not a
// name we're pitching.
const SKIP_DOMAIN = new Set([
  "snagged.com", "snagged.co", "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
  "icloud.com", "aol.com", "proton.me", "protonmail.com", "live.com", "mail.com",
  "qq.com", "163.com", "126.com", "yandex.com", "gmx.com", "me.com", "msn.com",
]);

// A bare domain token in the subject — the name being pitched. Strips Re:/Fwd:
// and a leading http(s):// that Gmail sometimes linkifies into the subject.
const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+)\b/i;
// TLDs we actually deal in — guards against matching "v2.0" / "inc.com signatures"
// noise; broad enough for our inventory (com/ai/io/co/app/net/org/xyz/dev/…).
const PLAUSIBLE_TLD = /\.(com|net|org|io|ai|co|app|dev|xyz|gg|tv|me|sh|so|inc|tech|club|live|store|fun|vc)$/i;

function firstRecipient(h: string): { name: string; email: string } | null {
  const m = /(?:"?([^"<>,]+?)"?\s*)?<?\s*([\w.\-+]+@[\w.\-]+)\s*>?/.exec(h || "");
  if (!m) return null;
  return { name: (m[1] || "").trim(), email: m[2].toLowerCase() };
}
function subjectDomain(subject: string): string | null {
  const s = (subject || "").replace(/^\s*(re|fwd|fw)\s*:\s*/i, "").replace(/https?:\/\//gi, "").trim();
  const m = DOMAIN_RE.exec(s);
  if (!m) return null;
  const d = m[1].toLowerCase().replace(/\.$/, "");
  if (SKIP_DOMAIN.has(d)) return null;
  return PLAUSIBLE_TLD.test(d) ? d : null;
}

export type PitchSuggestion = {
  domain: string;
  toName: string;
  toEmail: string;
  date: string; // YYYY-MM-DD
  subject: string;
  link: string; // gmail thread link
};

export type PitchScanResult = { mailbox: string; scanned: number; candidates: number; suggestions: PitchSuggestion[] };

// Scan the last `days` of Sent mail for untracked domain pitches.
export async function scanPitchSuggestions(days = 10): Promise<PitchScanResult> {
  const ids = await searchMessages(PITCH_MAILBOX, `in:sent newer_than:${days}d`, 300).catch(() => []);
  const tracked = await allExerciseDomains().catch(() => new Set<string>());

  // newest-first per (domain,recipient); dedupe.
  const byKey = new Map<string, PitchSuggestion>();
  let scanned = 0;
  for (const { id } of ids) {
    let m: GmailMessage;
    try { m = await getMessage(PITCH_MAILBOX, id); } catch { continue; }
    scanned++;
    if (!isUs(m.from)) continue; // only mail WE sent
    if (NOISE_SUBJECT.test(m.subject)) continue;
    const rcpt = firstRecipient(m.to);
    if (!rcpt || isUs(rcpt.email) || SYSTEM_RECIPIENT.test(rcpt.email)) continue; // need a real external person
    const domain = subjectDomain(m.subject);
    if (!domain) continue;
    if (tracked.has(domain)) continue; // already on a pitch-exercise sheet

    const key = `${domain}|${rcpt.email}`;
    const date = new Date(m.date).toISOString().slice(0, 10);
    const cand: PitchSuggestion = {
      domain,
      toName: rcpt.name || rcpt.email.split("@")[0],
      toEmail: rcpt.email,
      date,
      subject: m.subject.slice(0, 120),
      link: `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(m.mid)}`,
    };
    const ex = byKey.get(key);
    if (!ex || cand.date > ex.date) byKey.set(key, cand);
  }
  const suggestions = [...byKey.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
  return { mailbox: PITCH_MAILBOX, scanned, candidates: suggestions.length, suggestions };
}

// Render the digest email (HTML). Returns null when there's nothing to suggest.
export function renderPitchDigest(r: PitchScanResult): { subject: string; html: string } | null {
  if (!r.suggestions.length) return null;
  const rows = r.suggestions
    .map(
      (s) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600">${esc(s.domain)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee">${esc(s.toName)}<br><span style="color:#888;font-size:12px">${esc(s.toEmail)}</span></td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;white-space:nowrap">${esc(s.date)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee"><a href="${esc(s.link)}" style="color:#c0492f;text-decoration:none">${esc(s.subject)}</a></td>
      </tr>`,
    )
    .join("");
  const html = `<div style="font-family:system-ui,Arial,sans-serif;color:#254254;max-width:720px">
    <h2 style="margin:0 0 4px">Pitches to add to the sheet</h2>
    <p style="color:#555;margin:0 0 16px">Found ${r.suggestions.length} domain pitch${r.suggestions.length === 1 ? "" : "es"} you sent in the last 10 days that aren't on a tracked pitch-exercise sheet yet. Add the ones worth keeping.</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr>
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;color:#888;font-size:12px">Domain</th>
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;color:#888;font-size:12px">Pitched to</th>
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;color:#888;font-size:12px">Date</th>
        <th style="text-align:left;padding:8px 12px;border-bottom:2px solid #ddd;color:#888;font-size:12px">Email</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#999;font-size:12px;margin-top:16px">Scanned ${r.scanned} sent messages from ${esc(r.mailbox)}. Subject-anchored detection — if something here isn't a real pitch, ignore it.</p>
  </div>`;
  return { subject: `${r.suggestions.length} pitch${r.suggestions.length === 1 ? "" : "es"} to add to the sheet`, html };
}

function esc(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}
