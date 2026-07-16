// Daily digest rendering for the overlap flags — grouped by client, exact-TLD hits
// first. Produces an email HTML body + a compact Slack text. A flag with several
// client labels appears under each; flags with no client fall in an "to attribute"
// bucket (we chase down the client after a good hit).

import type { Flag } from "./match";

const UNKNOWN = "Unknown client — attribute after review";
const REPORT_URL = (process.env.APP_BASE_URL || "https://app.snagged.com") + "/reports/client-overlap";

function tierLabel(t: "exact_tld" | "affix"): string {
  return t === "exact_tld" ? "same word · new TLD" : ".com variation";
}
function priceLabel(f: Flag): string {
  if (f.price == null) return "";
  const n = Math.round(f.price);
  return ` · $${n.toLocaleString()}`;
}
function esc(s: string): string {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}

/** Group flags by client label (multi-client flags appear under each). */
function groupByClient(flags: Flag[]): Map<string, Flag[]> {
  const map = new Map<string, Flag[]>();
  for (const f of flags) {
    const labels = f.clients.length ? f.clients : [UNKNOWN];
    for (const c of labels) {
      const arr = map.get(c);
      if (arr) arr.push(f);
      else map.set(c, [f]);
    }
  }
  return map;
}

// Client sections sorted alphabetically, the Unknown bucket last.
function sortedClients(map: Map<string, Flag[]>): string[] {
  return [...map.keys()].sort((a, b) => {
    if (a === UNKNOWN) return 1;
    if (b === UNKNOWN) return -1;
    return a.localeCompare(b);
  });
}

// Exact-TLD before affix, then by candidate domain.
function sortFlags(flags: Flag[]): Flag[] {
  return [...flags].sort((a, b) => {
    if (a.best_tier !== b.best_tier) return a.best_tier === "exact_tld" ? -1 : 1;
    return a.candidate_domain.localeCompare(b.candidate_domain);
  });
}

export type Digest = { subject: string; html: string; slack: string; count: number };

export function buildDigest(flags: Flag[], runDate: string): Digest | null {
  if (!flags.length) return null;
  const byClient = groupByClient(flags);
  const clients = sortedClients(byClient);

  // ── Email HTML ──
  const sections = clients.map((client) => {
    const rows = sortFlags(byClient.get(client) || []).map((f) => {
      const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
      const link = f.link ? `<a href="${esc(f.link)}">${esc(f.candidate_domain)}</a>` : esc(f.candidate_domain);
      const feed = f.source_feed ? ` · <span style="color:#888">${esc(f.source_feed.split(",")[0])}</span>` : "";
      return `<li style="margin:4px 0"><strong>${link}</strong> <span style="color:#666">(${tierLabel(f.best_tier)}${priceLabel(f)})</span> — matches <em>${esc(anchors)}</em>${feed}</li>`;
    }).join("");
    return `<h3 style="margin:16px 0 4px">${esc(client)}</h3><ul style="margin:0;padding-left:18px">${rows}</ul>`;
  }).join("");

  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:640px">` +
    `<h2 style="margin:0 0 2px">Client domain overlap — ${esc(runDate)}</h2>` +
    `<p style="color:#666;margin:0 0 8px">${flags.length} new name${flags.length === 1 ? "" : "s"} related to a client's domains showed up today.</p>` +
    sections +
    `<p style="margin:18px 0 0"><a href="${esc(REPORT_URL)}">Open the full report →</a></p>` +
    `</div>`;

  // ── Slack text ──
  const slackLines = [`*Client domain overlap — ${runDate}* · ${flags.length} new match${flags.length === 1 ? "" : "es"}`];
  for (const client of clients) {
    slackLines.push(`\n*${client}*`);
    for (const f of sortFlags(byClient.get(client) || [])) {
      const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
      slackLines.push(`• ${f.candidate_domain} (${tierLabel(f.best_tier)}${priceLabel(f)}) — ${anchors}`);
    }
  }
  slackLines.push(`\n<${REPORT_URL}|Open the full report →>`);

  return { subject: `Client domain overlap — ${flags.length} new match${flags.length === 1 ? "" : "es"} (${runDate})`, html, slack: slackLines.join("\n"), count: flags.length };
}
