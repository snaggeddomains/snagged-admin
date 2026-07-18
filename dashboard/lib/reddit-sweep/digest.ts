// Slack + email digest for the social sweep. Leads with high-signal (buy-side
// acquisition intent), then maybe. Each row: subreddit · score · the matched "why" ·
// a one-line suggested angle · the link. Edge-triggered (only NET-NEW posts passed in).

import type { SweepPost } from "./store";

const REPORT_URL = (process.env.APP_BASE_URL || "https://app.snagged.com") + "/reports/social-sweep";

function esc(s: string): string {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));
}
function platformLabel(p: string): string {
  return p === "x" ? "X" : "Reddit";
}
function sourceLabel(p: SweepPost): string {
  return p.platform === "x" ? p.source : `r/${p.source}`;
}

export type Digest = { subject: string; html: string; slack: string; count: number };

export function buildSweepDigest(posts: SweepPost[]): Digest | null {
  if (!posts.length) return null;
  const platform = platformLabel(posts[0].platform);
  const high = posts.filter((p) => p.bucket === "high-signal").sort((a, b) => b.score - a.score);
  const maybe = posts.filter((p) => p.bucket === "maybe").sort((a, b) => b.score - a.score);

  // ── Slack ──
  const line = (p: SweepPost) => {
    const why = p.matched.slice(0, 4).join(", ");
    return `• <${p.link}|${sourceLabel(p)} · score ${p.score}> — ${p.title.slice(0, 120)}${why ? `  _(${why})_` : ""}${p.sample ? `\n    ↳ ${p.sample}` : ""}`;
  };
  const slackLines = [`*${platform} domain-opportunity sweep* · ${high.length} high-signal${maybe.length ? ` · ${maybe.length} maybe` : ""} new`];
  if (high.length) { slackLines.push(`\n:fire: *High-signal*`); for (const p of high) slackLines.push(line(p)); }
  if (maybe.length) { slackLines.push(`\n*Maybe*`); for (const p of maybe.slice(0, 15)) slackLines.push(line(p)); }
  slackLines.push(`\n<${REPORT_URL}|Open the full sweep →>`);

  // ── Email HTML ──
  const row = (p: SweepPost) => {
    const why = p.matched.slice(0, 5).join(", ");
    return `<li style="margin:6px 0"><a href="${esc(p.link)}"><strong>${esc(sourceLabel(p))}</strong> · score ${p.score}</a> — ${esc(p.title.slice(0, 140))}` +
      `${why ? ` <span style="color:#888">(${esc(why)})</span>` : ""}` +
      `${p.sample ? `<div style="color:#555;font-size:13px;margin-top:2px">↳ ${esc(p.sample)}</div>` : ""}</li>`;
  };
  const section = (t: string, arr: SweepPost[]) => arr.length ? `<h3 style="margin:16px 0 4px">${t} (${arr.length})</h3><ul style="margin:0;padding-left:18px">${arr.map(row).join("")}</ul>` : "";
  const html =
    `<div style="font-family:system-ui,Arial,sans-serif;max-width:660px">` +
    `<h2 style="margin:0 0 2px">${platform} domain-opportunity sweep</h2>` +
    `<p style="color:#666;margin:0 0 8px"><strong style="color:#b23000">${high.length} high-signal</strong>${maybe.length ? ` · ${maybe.length} maybe` : ""} new post${posts.length === 1 ? "" : "s"}.</p>` +
    section("🔥 High-signal", high) + section("Maybe", maybe.slice(0, 20)) +
    `<p style="margin:18px 0 0"><a href="${esc(REPORT_URL)}">Open the full sweep →</a></p></div>`;

  const subject = `${platform} sweep — ${high.length} high-signal domain lead${high.length === 1 ? "" : "s"}`;
  return { subject, html, slack: slackLines.join("\n"), count: posts.length };
}
