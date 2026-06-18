// Client-facing "Domain Activity Report" → a branded Google Doc.
//
// Pipeline: live DealReport + GA + newsletter → Docs-import-friendly HTML
// (table layout, inline styles, brand colors) → Drive imports it as an editable
// Google Doc, saved into a per-domain subfolder under the Activity Reports folder
// with a timestamped name (never overwrites a prior version — manual edits are
// always safe). Auth is the marketplace service account via domain-wide
// delegation (creates the Doc in the report owner's Drive). Server-only.

import { googleAccessToken, googleConfigured } from "./google-auth";
import { PNG } from "pngjs";
import type { DealReport } from "./marketplace-deals";
import type { ListingRow } from "./ga";
import type { NewsletterFeature } from "./newsletter";

const SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const subjectUser = () => process.env.GOOGLE_REPORT_SUBJECT || "rob@snagged.com";
const rootFolder = () => process.env.GOOGLE_REPORT_FOLDER || "1Ebjc3yr-4nVoHgSvXj-l0dxPBG_cV13I";

export function clientReportConfigured(): boolean {
  return googleConfigured() && !!rootFolder();
}

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => (s || "").replace(/[&<>"]/g, (c) => ENT[c]);
const fmt = (n: number) => (n || 0).toLocaleString();

// "2026-01-01"/"2026-06-17" → "January 1 – June 17, 2026" (or single date).
function periodLabel(from: string, to: string): string {
  const M = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const p = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return { y, m: M[(m || 1) - 1], d: dd }; };
  try {
    const a = p(from), b = p(to);
    if (a.y === b.y) return a.m === b.m ? `${a.m} ${a.d} – ${b.d}, ${b.y}` : `${a.m} ${a.d} – ${b.m} ${b.d}, ${b.y}`;
    return `${a.m} ${a.d}, ${a.y} – ${b.m} ${b.d}, ${b.y}`;
  } catch { return `${from} – ${to}`; }
}
const prettyDate = (d: string) => { const M = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]; const [y, m, dd] = (d || "").split("-").map(Number); return y ? `${M[(m || 1) - 1]} ${dd}, ${y}` : d; };

// Highest credible stated offer/budget across threads (ignores absurd > $10M junk).
function topOffer(report: DealReport): string | null {
  let best = 0;
  for (const t of report.threads) {
    const raw = (t.offer || t.budget || "").replace(/[^0-9]/g, "");
    const n = Number(raw);
    if (n >= 1000 && n <= 10_000_000 && n > best) best = n;
  }
  return best ? `$${best.toLocaleString()}` : null;
}

// ───────────────────────── HTML (Docs-import friendly) ─────────────────────────
export type ReportInput = {
  domain: string; host: string; from: string; to: string;
  report: DealReport; ga: ListingRow | null; newsletter: NewsletterFeature[];
  // Broker-maintained free-text notes (off-platform offers/context). Rendered
  // verbatim into the Doc when present. Optional.
  notes?: string | null;
  // Drafted narrative (LLM, best-effort), both fed by the full report + notes.
  // When present they replace the manual placeholders. generateReportDoc fills
  // these in when execSummary is not supplied. (Note-derived OFFERS are folded
  // into report.offers upstream in marketplace-deals.ts, not here.)
  execSummary?: string | null; // → Executive summary
  whatsNext?: string | null; // → "What's next" plan
};

const NAVY = "#254254", CORAL = "#c0492f", CORAL_SOFT = "#e07a5f", LINE = "#e3ddcf", MUTED = "#857c6c", GREEN = "#2f7d4f";

function statCard(n: string, label: string, accent = true): string {
  return `<td width="20%" align="center" style="border:1px solid ${LINE};padding:12pt 6pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:26pt;font-weight:700;color:${accent ? CORAL : NAVY};">${esc(n)}</div><div style="font-size:8.5pt;color:${MUTED};margin-top:4pt;">${esc(label)}</div></td>`;
}
function sectionHead(num: string, title: string, tag = ""): string {
  return `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:22pt 0 2pt 0;"><span style="color:${CORAL};">${num}</span>&nbsp; ${esc(title)}${tag ? ` <span style="font-size:9pt;color:${MUTED};font-family:Arial;">— ${esc(tag)}</span>` : ""}</h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">`;
}

export function buildReportHtml(input: ReportInput): string {
  const { domain, host, from, to, report, ga, newsletter, notes, execSummary, whatsNext } = input;
  const r = report;
  const cold = r.cold;
  const exercises = r.pitchExercises || [];
  const Domain = domain.charAt(0).toUpperCase() + domain.slice(1);
  const flameUrl = `${host}/api/og-mark?domain=${encodeURIComponent(domain)}`;
  const wordmark = `${host}/brand/report/snagged-wordmark-cream.png`;

  const proactive = (cold?.recipients || 0) + (r.pitchedIndividual || 0) + exercises.length;
  const responders = (r.inboundEngaged || 0) + (cold?.responded || 0);
  const touchpoints = (r.inbound || 0) + proactive;
  const offer = topOffer(r);
  const status = r.sale ? esc(r.sale.label) : "Active";

  // Firm-offers table. Unifies the email/CRM offers (r.offers) with any concrete
  // offers the LLM pulled out of the broker notes (input.noteOffers), so a deal
  // done over text/WhatsApp/phone shows up here too — sorted highest-first. Source
  // labels stay client-facing (the channel, "Inbound", "Pitched" — no internal jargon).
  const th = `text-align:left;padding:7pt 10pt;font-size:8.5pt;letter-spacing:1px;color:${MUTED};`;
  const td = `border-top:1px solid ${LINE};padding:7pt 10pt;vertical-align:top;`;
  // r.offers already unifies email/CRM offers, stated budgets, AND off-platform
  // offers from the broker notes (built in marketplace-deals.ts), so the Doc and
  // the admin view show an identical list. Source = the channel for a note offer,
  // else Inbound/Pitched.
  type OfferLine = { party: string; email: string | null; amount: string; amountNum: number; date: string; source: string; sourceColor: string; outcome: string | null; isBudget: boolean };
  const allOffers: OfferLine[] = (r.offers || [])
    .map((o) => ({
      party: o.party, email: o.email, amount: o.amount, amountNum: o.amountNum, date: o.date,
      source: o.channel || (o.origin === "inbound" ? "Inbound" : "Pitched"),
      sourceColor: o.channel ? NAVY : o.origin === "inbound" ? GREEN : "#5a4ec0",
      outcome: o.outcome, isBudget: o.kind === "budget",
    }))
    .sort((a, b) => b.amountNum - a.amountNum || (a.date < b.date ? 1 : -1));
  const offerRows = allOffers.map((o) => `<tr>
    <td style="${td}"><b style="color:${NAVY};">${esc(o.party)}</b>${o.email ? `<br><span style="color:${MUTED};font-size:9pt;">${esc(o.email)}</span>` : ""}</td>
    <td style="${td}white-space:nowrap;"><span style="font-family:'Fraunces',Georgia,serif;font-weight:700;color:${CORAL};font-size:14pt;">${esc(o.amount)}</span>${o.isBudget ? `<br><span style="color:${MUTED};font-size:8pt;">stated budget</span>` : ""}</td>
    <td style="${td}white-space:nowrap;color:${NAVY};">${esc(o.date)}</td>
    <td style="${td}color:${o.sourceColor};font-size:10pt;">${esc(o.source)}</td>
    <td style="${td}color:#43403a;">${esc(o.outcome || "—")}</td></tr>`).join("");
  const offersBlock = allOffers.length
    ? `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:20pt 0 2pt 0;">💰 Offers received <span style="font-size:9pt;color:${MUTED};font-family:Arial;">— what buyers put on the table</span></h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid ${LINE};"><thead><tr style="background-color:#efe7d3;"><th style="${th}">FROM</th><th style="${th}">OFFER / BUDGET</th><th style="${th}">DATE</th><th style="${th}">SOURCE</th><th style="${th}">WHAT HAPPENED</th></tr></thead><tbody>${offerRows}</tbody></table>`
    : "";

  // newsletter split + links
  const spotlights = newsletter.filter((f) => f.type === "for_sale");
  const content = newsletter.filter((f) => f.type === "content");
  const links = newsletter.filter((f) => f.archiveUrl).slice(0, 4)
    .map((f) => `&#9656; <a href="${esc(f.archiveUrl!)}" style="color:${CORAL};">${esc(f.subject || (f.type === "for_sale" ? "Newsletter spotlight" : "Content feature"))}</a>${f.date ? ` <span style="color:${MUTED};font-size:9pt;">· ${esc(prettyDate(f.date))}</span>` : ""}`)
    .join("<br>");
  const listingLink = `&#9656; <a href="https://www.snagged.com/domains/${esc(domain.replace(/\./g, "-"))}" style="color:${CORAL};">Marketplace listing — ${esc(domain)}</a>`;

  // curated-search bullets (anonymized: use the company-type description, never the client name).
  // Rendered as emphasized 11pt bullets — pitching to funded startups is a key differentiator.
  const bullets = exercises.map((e) => `<tr><td width="22" valign="top" style="border:none;padding:4pt 0;color:${CORAL};font-size:11pt;font-weight:700;line-height:1.4;">▸</td><td valign="top" style="border:none;padding:4pt 0;font-size:11pt;font-weight:600;color:${NAVY};line-height:1.4;">${esc(e.description || "A funded startup naming exercise")}</td></tr>`).join("");

  // "In their own words" — verbatim buyer/prospect pull-quotes. Attribution is the
  // report's anonymized label (never the lead's identity). No category labels.
  const quoteCallout = (q: { text: string; attribution: string; date: string }) =>
    `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 9pt 0;"><tr>
  <td style="border:1px solid ${LINE};border-left:4px solid ${CORAL};background-color:#fbf8ef;padding:12pt 16pt;">
    <div style="font-family:'Fraunces',Georgia,serif;font-size:13pt;font-style:italic;color:${NAVY};line-height:1.45;">&#8220;${esc(q.text)}&#8221;</div>
    <div style="font-size:9.5pt;color:${MUTED};margin-top:8pt;">— ${esc(q.attribution)}${q.date ? ` &middot; ${esc(prettyDate(q.date))}` : ""}</div>
  </td></tr></table>`;
  // Fallback notes block — only used when the LLM didn't run (no API key); then we
  // render the broker's notes verbatim so the context is never lost. When the LLM
  // IS available the notes are integrated across the report (offers table +
  // summary + plan) instead of dumped here. Client-friendly heading (no jargon).
  const notesText = (notes || "").trim();
  const notesFallbackBlock = notesText
    ? `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:22pt 0 2pt 0;">&#128204; Additional context</h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin:0 0 4pt 0;"><tr>
  <td style="border:1px solid ${LINE};border-left:4px solid ${CORAL};background-color:#fbf8ef;padding:14pt 16pt;color:#33312c;font-size:11pt;line-height:1.55;">${esc(notesText).replace(/\r?\n/g, "<br>")}</td>
</tr></table>`
    : "";

  const highlights = (r.highlights || []).slice(0, 6);
  const quotesBlock = highlights.length
    ? `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:22pt 0 2pt 0;">&#128172; In their own words <span style="font-size:9pt;color:${MUTED};font-family:Arial;">— verbatim from buyer &amp; prospect conversations</span></h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">
<p style="margin:0 0 10pt 0;">Behind the numbers are real conversations. A representative sample of what buyers and prospects have actually told us about ${esc(Domain)} — interest, objections, and feedback on price:</p>
${highlights.map(quoteCallout).join("\n")}`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:'Inter',Arial,sans-serif;color:#2a2a28;font-size:11pt;line-height:1.5;margin:0;">

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>
<td style="background-color:${NAVY};padding:48pt 40pt 44pt 40pt;" align="center">
  <p align="center" style="margin:0;"><img src="${wordmark}" alt="Snagged" width="180" style="display:block;"></p>
  <p align="center" style="margin:28pt 0 0 0;"><img src="${flameUrl}" alt="${esc(Domain)}" width="92" style="display:block;"></p>
  <div style="text-align:center;color:${CORAL_SOFT};font-size:9pt;letter-spacing:3px;font-weight:bold;margin-top:24pt;">PREPARED FOR THE OWNER OF</div>
  <div style="text-align:center;font-family:'Fraunces',Georgia,serif;font-size:50pt;font-weight:600;color:#ffffff;line-height:1.02;margin-top:6pt;">${esc(Domain)}</div>
  <div style="text-align:center;color:${CORAL_SOFT};font-size:15pt;line-height:1;letter-spacing:2px;margin-top:14pt;">━━━━</div>
  <div style="text-align:center;color:#aebcc4;font-size:10pt;margin-top:14pt;">Domain Activity Report &nbsp;&middot;&nbsp; ${esc(periodLabel(from, to))} &nbsp;&middot;&nbsp; Status: <b style="color:#ffffff;">${status}</b></div>
</td></tr></table>

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:14pt;"><tr>
  ${statCard(fmt(r.inboundQualified), "Qualified inbound inquiries")}
  ${statCard(fmt(proactive), "Prospects we proactively pitched")}
  ${statCard(fmt(cold?.opened || 0), "Opened our outreach", false)}
  ${statCard(fmt(responders), "Buyers who replied", false)}
  ${statCard(fmt(exercises.length), "Curated client name searches")}
</tr></table>

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:18pt;"><tr>
<td style="background-color:#ffffff;border:1px solid ${LINE};border-left:4px solid ${CORAL};padding:14pt 16pt;">
  <div style="font-family:'Fraunces',Georgia,serif;font-size:13pt;font-weight:700;color:${NAVY};">Executive summary</div>
  ${(execSummary || "").trim()
    ? `<div style="margin-top:6pt;color:#33312c;line-height:1.55;">${esc((execSummary as string).trim()).replace(/\r?\n/g, "<br>")}</div>
  <div style="color:#b3a994;font-style:italic;font-size:8.5pt;margin-top:7pt;">Draft — review and personalize before sending.</div>`
    : `<div style="color:#9a8f78;font-style:italic;margin-top:5pt;">[ Write a short personal note here before sending — the level of demand this period, the most promising conversations, and our read on price and positioning for ${esc(Domain)}. ]</div>`}
</td></tr></table>

${sectionHead("01", "Inbound demand", "buyers who came to us")}
<p style="margin:0 0 8pt 0;">${esc(Domain)} attracts unsolicited interest — a strong signal of the name's pull. This period we logged <b style="color:${NAVY};">${fmt(r.inbound)} inbound contacts</b>, of which <b style="color:${NAVY};">${fmt(r.inboundQualified)} were qualified</b> (credible buyer, business email, or stated budget), and <b style="color:${NAVY};">${fmt(r.inboundEngaged)} became genuine two-way negotiations</b> after our reply.${offer ? ` Highest stated budget: <b style="color:${NAVY};">${esc(offer)}</b>.` : ""}</p>

${offersBlock}

${execSummary ? "" : notesFallbackBlock}

${quotesBlock}

${cold ? `${sectionHead("02", "Proactive outreach", "our targeted campaigns")}
<table width="100%" cellpadding="0" cellspacing="0" style="border:none;border-collapse:collapse;"><tr>
<td style="vertical-align:middle;border:none;padding-right:14pt;"><p style="margin:0;">We don't wait for buyers — we run targeted campaigns to the companies most likely to want ${esc(Domain)} and track every send. This period we reached <b style="color:${NAVY};">${fmt(cold.recipients)} vetted prospects</b> (${fmt(cold.sends)} touches across the sequence):</p></td>
<td width="120" align="right" style="vertical-align:middle;border:none;"><img src="${host}/brand/report/mascot-negotiation.png" alt="" width="108" style="display:block;"></td>
</tr></table>
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:8pt;"><tr>
  <td width="20%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(cold.recipients)}</div><div style="font-size:8pt;color:${MUTED};">Prospects reached</div></td>
  <td width="20%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(cold.sends)}</div><div style="font-size:8pt;color:${MUTED};">Emails sent</div></td>
  <td width="20%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${CORAL};">${fmt(cold.opened)}</div><div style="font-size:8pt;color:${GREEN};font-weight:bold;">Opened${cold.recipients ? ` · ${Math.round((cold.opened / cold.recipients) * 100)}%` : ""}</div></td>
  <td width="20%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(cold.clicked)}</div><div style="font-size:8pt;color:${MUTED};">Clicked</div></td>
  <td width="20%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${CORAL};">${fmt(cold.replied)}</div><div style="font-size:8pt;color:${GREEN};font-weight:bold;">Replied${cold.recipients ? ` · ${Math.round((cold.replied / cold.recipients) * 100)}%` : ""}</div></td>
</tr></table>
${r.pitchedIndividual ? `<p style="margin:10pt 0 0 0;">Plus <b style="color:${NAVY};">${fmt(r.pitchedIndividual)} individual one-to-one pitches</b> to specific decision-makers.</p>` : ""}` : ""}

${exercises.length ? `${sectionHead("03", "Curated name searches", "in front of founders & CEOs")}
<p style="margin:0 0 8pt 0;">A major part of our distribution is the naming work we do for venture-backed startups. Founders and CEOs rely on Snagged to know which premium domains are actually available when they name or rebrand a company — and when ${esc(Domain)} fits a brief, we put it directly in front of them. This period it was included in <b style="color:${NAVY};">${fmt(exercises.length)} curated name searches</b> prepared for funded companies:</p>
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:none;margin:0 0 8pt 0;">${bullets}</table>
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr><td style="background-color:${NAVY};padding:14pt 16pt;color:#eaf0f3;"><div style="font-family:'Fraunces',Georgia,serif;font-size:12pt;font-weight:600;color:#ffffff;">Why this matters</div><div style="font-size:10pt;margin-top:4pt;color:#cdd8de;">These aren't cold lists — they're founders in active decision-making with budget and urgency. Each inclusion puts ${esc(Domain)} on the shortlist for a company's permanent identity, the highest-intent audience a domain can reach.</div></td></tr></table>` : ""}

${sectionHead("04", "Marketing & exposure")}
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>
  <td width="25%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${CORAL};">${fmt(spotlights.length)}</div><div style="font-size:8pt;color:${MUTED};">Newsletter spotlights</div></td>
  <td width="25%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(content.length)}</div><div style="font-size:8pt;color:${MUTED};">Content features</div></td>
  <td width="25%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(ga?.views || 0)}</div><div style="font-size:8pt;color:${MUTED};">Listing visits</div></td>
  <td width="25%" align="center" style="border:1px solid ${LINE};padding:10pt 4pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:20pt;font-weight:700;color:${NAVY};">${fmt(ga?.users || 0)}</div><div style="font-size:8pt;color:${MUTED};">Unique visitors</div></td>
</tr></table>
<p style="margin:10pt 0 4pt 0;">${esc(Domain)} is listed on the Snagged marketplace and featured to our buyer audience. Selected exposure:</p>
<p style="margin:0;line-height:1.7;">${links ? links + "<br>" : ""}${listingLink}</p>

${sectionHead("05", "Where things stand", "status & momentum")}
<p style="margin:0;">Demand is broad-based across multiple industries. ${r.activeNegotiations ? `<b style="color:${NAVY};">${fmt(r.activeNegotiations)} live ${r.activeNegotiations === 1 ? "negotiation is" : "negotiations are"} open.</b> ` : ""}${r.sale ? `Sale status: <b style="color:${NAVY};">${esc(r.sale.label)}</b>.` : `No offer has been accepted yet — several conversations sit at the price-discovery stage, typical for a premium name and exactly where our follow-up cadence does its work.`}</p>

${sectionHead("06", "What's next", "our plan from here")}
${(whatsNext || "").trim()
    ? `<p style="margin:0;color:#33312c;line-height:1.55;">${esc((whatsNext as string).trim()).replace(/\r?\n/g, "<br>")}</p>
<p style="margin:6pt 0 0 0;color:#b3a994;font-style:italic;font-size:8.5pt;">Draft — review and personalize before sending.</p>`
    : `<p style="margin:0;color:#9a8f78;font-style:italic;">[ Finalize before sending. Draft: re-engage the warmest prospects from this cycle, expand outreach into adjacent buyer categories, keep ${esc(Domain)} in rotation for upcoming founder name searches, and surface any serious offer to you immediately. ]</p>`}

${sectionHead("07", "The bottom line")}
<table width="100%" cellpadding="0" cellspacing="0" style="border:none;border-collapse:collapse;"><tr>
<td style="vertical-align:middle;border:none;padding-right:14pt;"><p style="margin:0;font-size:12pt;"><b style="color:${NAVY};">${esc(Domain)} is a genuinely in-demand asset.</b> This period we generated ${fmt(touchpoints)} buyer touchpoints, qualified ${fmt(r.inboundQualified)} inbound buyers, proactively pitched ${fmt(proactive)} prospects${exercises.length ? `, put the name in front of ${fmt(exercises.length)} founding teams` : ""}, and opened real conversations — and the marketing engine behind it runs every day.</p></td>
<td width="130" align="right" style="vertical-align:middle;border:none;"><img src="${host}/brand/report/mascot-hero.png" alt="" width="120" style="display:block;"></td>
</tr></table>

<p style="margin:24pt 0 0 0;border-top:1px solid ${LINE};padding-top:10pt;font-size:8.5pt;color:${MUTED};">Prepared by <b style="color:${NAVY};">Snagged</b> &nbsp;&nbsp;|&nbsp;&nbsp; Confidential Information — prepared for the owner of ${esc(domain)} only</p>
</body></html>`;
}

// ───────────────────────── Drive ─────────────────────────
async function driveJson(token: string, url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) } });
  if (!res.ok) throw new Error(`drive ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Find-or-create the per-domain subfolder under the Activity Reports root.
async function domainFolder(token: string, domain: string): Promise<string> {
  const Domain = domain.charAt(0).toUpperCase() + domain.slice(1);
  const q = `name='${Domain.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${rootFolder()}' in parents and trashed=false`;
  const list = await driveJson(token, `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`);
  const found = (list.files as { id: string }[] | undefined)?.[0]?.id;
  if (found) return found;
  const created = await driveJson(token, `${DRIVE}/files?supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: Domain, mimeType: "application/vnd.google-apps.folder", parents: [rootFolder()] }),
  });
  return created.id as string;
}

// Draft the report's prose AND decompose the broker notes (best-effort LLM), in
// ONE call. Returns: the executive summary, the "What's next" plan, and any
// concrete offers pulled OUT of the notes (so a deal done over text/WhatsApp/phone
// lands in the Offers table, not a separate dump). Everything is fed by the FULL
// report — metrics, firm offers, verbatim highlights — AND the notes, which get
// woven across the report rather than dumped. Notes are one input, never the sole
// driver. Empty when no API key (the Doc then shows manual placeholders +
// a verbatim notes fallback). Server-only.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export async function draftReportNarrative(input: ReportInput): Promise<{ summary: string; outlook: string }> {
  const empty = { summary: "", outlook: "" };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return empty;
  const { domain, report: r } = input;
  const cold = r.cold;
  const exercises = r.pitchExercises || [];
  const proactive = (cold?.recipients || 0) + (r.pitchedIndividual || 0) + exercises.length;
  const offer = topOffer(r);
  const facts: string[] = [
    `Domain: ${domain}`,
    `Inbound contacts: ${r.inbound} (qualified: ${r.inboundQualified}; became two-way negotiations: ${r.inboundEngaged})`,
    `Active live negotiations: ${r.activeNegotiations}`,
    `Proactively pitched: ${proactive}${exercises.length ? ` (incl. ${exercises.length} funded-startup naming searches)` : ""}`,
  ];
  if (cold) facts.push(`Cold outreach: ${cold.recipients} prospects, ${cold.opened} opened, ${cold.replied} replied`);
  if (offer) facts.push(`Highest stated budget/offer: ${offer}`);
  if (r.sale) facts.push(`Sale status: ${r.sale.label}`);
  if ((r.offers || []).length) {
    facts.push("Offers & stated budgets buyers put forward: " + r.offers.slice(0, 8).map((o) => `${o.amount}${o.kind === "budget" ? " (stated budget)" : ""}${o.outcome ? ` — ${o.outcome}` : ""}`).join("; "));
  }
  if ((r.highlights || []).length) {
    facts.push("Representative buyer quotes: " + r.highlights.slice(0, 5).map((q) => `"${q.text}" [${q.kind}]`).join(" | "));
  }
  const notes = (input.notes || "").trim();
  if (notes) facts.push(`Broker notes — activity & context not in email (offers via text/WhatsApp/phone, verbal context, owner instructions). Any concrete dollar offers in here are ALREADY in the offers list above; weave the rest of this context into the summary and plan:\n${notes.slice(0, 3000)}`);

  const system =
    `You write the prose for a domain owner's activity report, prepared by Snagged — the owner's domain broker (write as "we"). ` +
    `Return STRICT JSON: {"summary":"...","outlook":"..."}. ` +
    `"summary" = the executive summary, 3–5 sentences, one paragraph: the level of demand this period, the most promising conversations and any firm offers, and our read on price/positioning. ` +
    `"outlook" = the "What's next" plan, 2–4 sentences: the concrete next steps from here (re-engage the warmest prospects, expand into adjacent buyer categories, keep the name in founder naming searches, act on any live offer). ` +
    `Confident and professional but factual. Use ONLY the facts provided — never invent numbers, names, or offers. Reflect the notes' context where relevant. ` +
    `Write for the CLIENT: do NOT use internal jargon like "off-platform", "CRM", "HubSpot", or "sequence" in any output text. ` +
    `No greeting, no sign-off, no markdown, no headers. Refer to the domain by name.`;
  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.DEAL_SUMMARY_MODEL || process.env.DEAL_RECAP_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 700,
        system,
        messages: [{ role: "user", content: `Write the report prose from these facts:\n\n${facts.join("\n")}` }],
      }),
    });
    if (!res.ok) return empty;
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text || "").join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e <= s) return empty;
    const obj = JSON.parse(text.slice(s, e + 1)) as { summary?: string; outlook?: string };
    return {
      summary: (obj.summary || "").toString().trim().slice(0, 1200),
      outlook: (obj.outlook || "").toString().trim().slice(0, 900),
    };
  } catch {
    return empty;
  }
}

// Generate the Doc: build HTML, import into the per-domain subfolder under a
// timestamped name (never overwrites). Returns the Doc + folder links.
export async function generateReportDoc(input: ReportInput): Promise<{ docUrl: string; folderUrl: string; name: string }> {
  const token = await googleAccessToken(SCOPE, subjectUser());
  const folder = await domainFolder(token, input.domain);
  // Draft the report prose (exec summary + what's-next) from the full report +
  // notes, unless the caller already supplied a summary. Note-derived OFFERS are
  // already in report.offers (built upstream). Best-effort — falls back to the
  // manual placeholders + verbatim notes.
  let withProse = input;
  if (input.execSummary == null) {
    const { summary, outlook } = await draftReportNarrative(input);
    withProse = { ...input, execSummary: summary, whatsNext: input.whatsNext ?? outlook };
  }
  const html = buildReportHtml(withProse);
  const Domain = input.domain.charAt(0).toUpperCase() + input.domain.slice(1);
  const now = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())} ${p(now.getUTCHours())}:${p(now.getUTCMinutes())} UTC`;
  const name = `${Domain} Activity Report — ${ts}`;
  const bnd = `snagged_${Date.now()}`;
  const meta = { name, mimeType: "application/vnd.google-apps.document", parents: [folder] };
  const body = Buffer.concat([
    Buffer.from(`--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`),
    Buffer.from(`--${bnd}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n`),
    Buffer.from(html),
    Buffer.from(`\r\n--${bnd}--`),
  ]);
  const created = await driveJson(token, `${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${bnd}` }, body: body as unknown as BodyInit,
  });
  return {
    docUrl: `https://docs.google.com/document/d/${created.id}/edit`,
    folderUrl: `https://drive.google.com/drive/folders/${folder}`,
    name,
  };
}

// ───────────────────────── image trim (for /api/og-mark) ─────────────────────────
// Trim a uniform border (the listing logo's padding) off a PNG, keeping the
// interior intact. Pure-JS (pngjs), no native deps. Returns the original on any
// failure / if the image is all background.
export function trimPng(buf: Buffer): Buffer {
  try {
    const png = PNG.sync.read(buf);
    const { width, height, data } = png;
    const at = (x: number, y: number) => (y * width + x) * 4;
    const c0 = [data[0], data[1], data[2]];
    const isBg = (x: number, y: number) => {
      const i = at(x, y);
      return Math.abs(data[i] - c0[0]) + Math.abs(data[i + 1] - c0[1]) + Math.abs(data[i + 2] - c0[2]) < 40;
    };
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!isBg(x, y)) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < minX) return buf;
    const pad = 2;
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad); maxY = Math.min(height - 1, maxY + pad);
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const out = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = at(minX + x, minY + y), d = (y * w + x) * 4;
      out.data[d] = data[s]; out.data[d + 1] = data[s + 1]; out.data[d + 2] = data[s + 2]; out.data[d + 3] = data[s + 3];
    }
    return PNG.sync.write(out);
  } catch { return buf; }
}
