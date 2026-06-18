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
};

const NAVY = "#254254", CORAL = "#c0492f", CORAL_SOFT = "#e07a5f", LINE = "#e3ddcf", MUTED = "#857c6c", GREEN = "#2f7d4f";

function statCard(n: string, label: string, accent = true): string {
  return `<td width="20%" align="center" style="border:1px solid ${LINE};padding:12pt 6pt;"><div style="font-family:'Fraunces',Georgia,serif;font-size:26pt;font-weight:700;color:${accent ? CORAL : NAVY};">${esc(n)}</div><div style="font-size:8.5pt;color:${MUTED};margin-top:4pt;">${esc(label)}</div></td>`;
}
function sectionHead(num: string, title: string, tag = ""): string {
  return `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:22pt 0 2pt 0;"><span style="color:${CORAL};">${num}</span>&nbsp; ${esc(title)}${tag ? ` <span style="font-size:9pt;color:${MUTED};font-family:Arial;">— ${esc(tag)}</span>` : ""}</h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">`;
}

export function buildReportHtml(input: ReportInput): string {
  const { domain, host, from, to, report, ga, newsletter } = input;
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

  // Firm-offers table (only when we've actually received offers).
  const th = `text-align:left;padding:7pt 10pt;font-size:8.5pt;letter-spacing:1px;color:${MUTED};`;
  const td = `border-top:1px solid ${LINE};padding:7pt 10pt;vertical-align:top;`;
  const offerRows = (r.offers || []).map((o) => `<tr>
    <td style="${td}"><b style="color:${NAVY};">${esc(o.party)}</b>${o.email ? `<br><span style="color:${MUTED};font-size:9pt;">${esc(o.email)}</span>` : ""}</td>
    <td style="${td}white-space:nowrap;font-family:'Fraunces',Georgia,serif;font-weight:700;color:${CORAL};font-size:14pt;">${esc(o.amount)}</td>
    <td style="${td}white-space:nowrap;color:${NAVY};">${esc(o.date)}</td>
    <td style="${td}color:${o.origin === "inbound" ? GREEN : "#5a4ec0"};font-size:10pt;">${o.origin === "inbound" ? "Inbound" : "Pitched"}</td>
    <td style="${td}color:#43403a;">${esc(o.outcome || "—")}</td></tr>`).join("");
  const offersBlock = (r.offers || []).length
    ? `<h2 style="font-family:'Fraunces',Georgia,serif;color:${NAVY};font-size:16pt;margin:20pt 0 2pt 0;">💰 Offers received <span style="font-size:9pt;color:${MUTED};font-family:Arial;">— firm amounts buyers named</span></h2><hr style="border:none;border-top:2px solid ${CORAL};width:38%;margin:0 0 10pt 0;">
<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid ${LINE};"><thead><tr style="background-color:#efe7d3;"><th style="${th}">FROM</th><th style="${th}">OFFER</th><th style="${th}">DATE</th><th style="${th}">SOURCE</th><th style="${th}">WHAT HAPPENED</th></tr></thead><tbody>${offerRows}</tbody></table>`
    : "";

  // newsletter split + links
  const spotlights = newsletter.filter((f) => f.type === "for_sale");
  const content = newsletter.filter((f) => f.type === "content");
  const links = newsletter.filter((f) => f.archiveUrl).slice(0, 4)
    .map((f) => `&#9656; <a href="${esc(f.archiveUrl!)}" style="color:${CORAL};">${esc(f.subject || (f.type === "for_sale" ? "Newsletter spotlight" : "Content feature"))}</a>${f.date ? ` <span style="color:${MUTED};font-size:9pt;">· ${esc(prettyDate(f.date))}</span>` : ""}`)
    .join("<br>");
  const listingLink = `&#9656; <a href="https://www.snagged.com/domains/${esc(domain.replace(/\./g, "-"))}" style="color:${CORAL};">Marketplace listing — ${esc(domain)}</a>`;

  // curated-search chips (anonymized: use the company-type description, never the client name)
  const chips = exercises.map((e) => `<span style="display:inline-block;border:1px solid ${LINE};border-radius:12pt;padding:4pt 10pt;margin:0 6pt 6pt 0;font-size:10pt;color:${NAVY};">${esc(e.description || "A funded startup naming exercise")}</span>`).join(" ");

  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="font-family:'Inter',Arial,sans-serif;color:#2a2a28;font-size:11pt;line-height:1.5;margin:0;">

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;"><tr>
<td style="background-color:${NAVY};padding:48pt 40pt 44pt 40pt;" align="center">
  <p align="center" style="margin:0;"><img src="${wordmark}" alt="Snagged" width="128" style="display:block;"></p>
  <p align="center" style="margin:26pt 0 0 0;"><img src="${flameUrl}" alt="${esc(Domain)}" width="58" style="display:block;"></p>
  <div style="text-align:center;color:${CORAL_SOFT};font-size:9pt;letter-spacing:3px;font-weight:bold;margin-top:22pt;">PREPARED FOR THE OWNER OF</div>
  <div style="text-align:center;font-family:'Fraunces',Georgia,serif;font-size:46pt;font-weight:600;color:#ffffff;line-height:1.02;margin-top:6pt;">${esc(Domain)}</div>
  <div style="text-align:center;color:${CORAL_SOFT};font-size:15pt;line-height:1;letter-spacing:2px;margin-top:14pt;">━━━━</div>
  <div style="text-align:center;color:#aebcc4;font-size:10pt;margin-top:14pt;">Domain Activity Report &nbsp;&middot;&nbsp; ${esc(periodLabel(from, to))} &nbsp;&middot;&nbsp; Status: <b style="color:#ffffff;">${status}</b></div>
</td></tr></table>

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:14pt;"><tr>
  ${statCard(fmt(r.inboundQualified), "Qualified inbound inquiries")}
  ${statCard(fmt(proactive), "Prospects we proactively pitched")}
  ${statCard(fmt(cold?.opened || 0), "Opened our cold outreach", false)}
  ${statCard(fmt(responders), "Buyers who replied", false)}
  ${statCard(fmt(exercises.length), "Curated client name searches")}
</tr></table>

<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-top:18pt;"><tr>
<td style="background-color:#ffffff;border:1px solid ${LINE};border-left:4px solid ${CORAL};padding:14pt 16pt;">
  <div style="font-family:'Fraunces',Georgia,serif;font-size:13pt;font-weight:700;color:${NAVY};">Executive summary</div>
  <div style="color:#9a8f78;font-style:italic;margin-top:5pt;">[ Write a short personal note here before sending — the level of demand this period, the most promising conversations, and our read on price and positioning for ${esc(Domain)}. ]</div>
</td></tr></table>

${sectionHead("01", "Inbound demand", "buyers who came to us")}
<p style="margin:0 0 8pt 0;">${esc(Domain)} attracts unsolicited interest — a strong signal of the name's pull. This period we logged <b style="color:${NAVY};">${fmt(r.inbound)} inbound contacts</b>, of which <b style="color:${NAVY};">${fmt(r.inboundQualified)} were qualified</b> (credible buyer, business email, or stated budget), and <b style="color:${NAVY};">${fmt(r.inboundEngaged)} became genuine two-way negotiations</b> after our reply.${offer ? ` Highest stated budget: <b style="color:${NAVY};">${esc(offer)}</b>.` : ""}</p>

${offersBlock}

${cold ? `${sectionHead("02", "Proactive cold outreach", "tracked in HubSpot")}
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
<p style="margin:0 0 6pt 0;">${chips}</p>
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
<p style="margin:0;color:#9a8f78;font-style:italic;">[ Finalize before sending. Draft: re-engage the warmest prospects from this cycle, expand outreach into adjacent buyer categories, keep ${esc(Domain)} in rotation for upcoming founder name searches, and surface any serious offer to you immediately. ]</p>

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

// Generate the Doc: build HTML, import into the per-domain subfolder under a
// timestamped name (never overwrites). Returns the Doc + folder links.
export async function generateReportDoc(input: ReportInput): Promise<{ docUrl: string; folderUrl: string; name: string }> {
  const token = await googleAccessToken(SCOPE, subjectUser());
  const folder = await domainFolder(token, input.domain);
  const html = buildReportHtml(input);
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
