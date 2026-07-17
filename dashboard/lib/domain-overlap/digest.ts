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
// Human "ends in Nh / Nd" from an ISO end time (auction urgency).
function endsIn(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  if (diff <= 0) return "ending now";
  const hrs = diff / 3_600_000;
  if (hrs < 1) return `ends in ${Math.max(1, Math.round(diff / 60_000))}m`;
  if (hrs < 24) return `ends in ${Math.round(hrs)}h`;
  return `ends in ${Math.round(hrs / 24)}d`;
}
function clientsOf(f: Flag): string {
  return f.clients.filter(Boolean).join(", ");
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

  // Auctions are the urgent signal — the client almost certainly doesn't know their
  // word is live at auction. Lead with them, soonest-ending first, delineated from
  // the (non-time-sensitive) for-sale matches below.
  const auctions = flags
    .filter((f) => f.kind === "auction")
    .sort((a, b) => (Date.parse(a.ends_at || "") || Infinity) - (Date.parse(b.ends_at || "") || Infinity));
  const saleFlags = flags.filter((f) => f.kind !== "auction");

  const byClient = groupByClient(saleFlags);
  const clients = sortedClients(byClient);

  // ── Auction block (email) ──
  const auctionHtml = auctions.length
    ? `<h3 style="margin:14px 0 4px;color:#8a1f00">🔨 At auction — time-sensitive (${auctions.length})</h3>` +
      `<ul style="margin:0;padding-left:18px">` +
      auctions.map((f) => {
        const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
        const link = f.link ? `<a href="${esc(f.link)}">${esc(f.candidate_domain)}</a>` : esc(f.candidate_domain);
        const ends = endsIn(f.ends_at);
        const who = clientsOf(f);
        return `<li style="margin:4px 0"><strong>${link}</strong> <span style="color:#666">(${tierLabel(f.best_tier)}${priceLabel(f)}${ends ? ` · <span style="color:#cf3b3b">${ends}</span>` : ""})</span> — matches <em>${esc(anchors)}</em>${who ? ` · <span style="color:#888">${esc(who)}</span>` : ""}</li>`;
      }).join("") +
      `</ul>`
    : "";

  // ── Email HTML (for-sale, grouped by client) ──
  const sections = clients.map((client) => {
    const rows = sortFlags(byClient.get(client) || []).map((f) => {
      const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
      const link = f.link ? `<a href="${esc(f.link)}">${esc(f.candidate_domain)}</a>` : esc(f.candidate_domain);
      const feed = f.source_feed ? ` · <span style="color:#888">${esc(f.source_feed.split(",")[0])}</span>` : "";
      return `<li style="margin:4px 0"><strong>${link}</strong> <span style="color:#666">(${tierLabel(f.best_tier)}${priceLabel(f)})</span> — matches <em>${esc(anchors)}</em>${feed}</li>`;
    }).join("");
    return `<h3 style="margin:16px 0 4px">${esc(client)}</h3><ul style="margin:0;padding-left:18px">${rows}</ul>`;
  }).join("");

  const summaryLine = auctions.length
    ? `<strong style="color:#8a1f00">${auctions.length} at auction</strong>${saleFlags.length ? ` · ${saleFlags.length} for sale` : ""}`
    : `${flags.length} new name${flags.length === 1 ? "" : "s"} related to a client's domains showed up today.`;

  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:640px">` +
    `<h2 style="margin:0 0 2px">Client domain overlap — ${esc(runDate)}</h2>` +
    `<p style="color:#666;margin:0 0 8px">${summaryLine}</p>` +
    auctionHtml +
    (saleFlags.length ? `<h3 style="margin:18px 0 4px;color:#555">For sale (${saleFlags.length})</h3>` : "") +
    sections +
    `<p style="margin:18px 0 0"><a href="${esc(REPORT_URL)}">Open the full report →</a></p>` +
    `</div>`;

  // ── Slack text ──
  const headline = auctions.length
    ? `*Client domain overlap — ${runDate}* · :hammer: *${auctions.length} at auction*${saleFlags.length ? ` · ${saleFlags.length} for sale` : ""}`
    : `*Client domain overlap — ${runDate}* · ${flags.length} new match${flags.length === 1 ? "" : "es"}`;
  const slackLines = [headline];
  if (auctions.length) {
    slackLines.push(`\n:hammer: *At auction — time-sensitive*`);
    for (const f of auctions) {
      const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
      const ends = endsIn(f.ends_at);
      const who = clientsOf(f);
      slackLines.push(`• ${f.candidate_domain} (${tierLabel(f.best_tier)}${priceLabel(f)}${ends ? ` · ${ends}` : ""}) — ${anchors}${who ? ` · ${who}` : ""}`);
    }
  }
  if (saleFlags.length) {
    if (auctions.length) slackLines.push(`\n*For sale*`);
    for (const client of clients) {
      slackLines.push(`\n*${client}*`);
      for (const f of sortFlags(byClient.get(client) || [])) {
        const anchors = [...new Set(f.matches.map((m) => m.anchor))].join(", ");
        slackLines.push(`• ${f.candidate_domain} (${tierLabel(f.best_tier)}${priceLabel(f)}) — ${anchors}`);
      }
    }
  }
  slackLines.push(`\n<${REPORT_URL}|Open the full report →>`);

  const subject = auctions.length
    ? `🔨 ${auctions.length} client domain${auctions.length === 1 ? "" : "s"} at auction${saleFlags.length ? ` + ${saleFlags.length} for sale` : ""} (${runDate})`
    : `Client domain overlap — ${flags.length} new match${flags.length === 1 ? "" : "es"} (${runDate})`;

  return { subject, html, slack: slackLines.join("\n"), count: flags.length };
}
