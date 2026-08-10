// Weekly SEO digest — a short "what moved, what to do" summary for Slack + email,
// built from the live report. Focuses on money-term movement + the open action loop.
import { buildSeoReport, type SeoReport } from "./report";

const APP_BASE = (process.env.DASHBOARD_BASE || "https://app.snagged.com").replace(/\/+$/, "");
const pos = (p: number | null) => (p == null ? "—" : p.toFixed(1));
const arrow = (d: number | null) => (d == null ? "" : d > 0 ? `▲${d.toFixed(1)}` : d < 0 ? `▼${Math.abs(d).toFixed(1)}` : "•");

export type SeoDigest = { subject: string; slack: string; html: string; report: SeoReport };

export async function buildSeoDigest(): Promise<SeoDigest> {
  const r = await buildSeoReport();
  const link = `${APP_BASE}/reports/seo`;

  const ranked = r.targets.filter((t) => t.priority <= 2);
  const rankingCount = r.targets.filter((t) => t.position != null).length;
  const gainers = r.targets.filter((t) => t.status === "gaining").sort((a, b) => (b.delta || 0) - (a.delta || 0)).slice(0, 5);
  const losers = r.targets.filter((t) => t.status === "losing").sort((a, b) => (a.delta || 0) - (b.delta || 0)).slice(0, 5);
  const notRanking = r.targets.filter((t) => t.status === "not_ranking").slice(0, 6);
  const openActions = r.actions.filter((a) => a.status !== "done");

  const subject = `📈 SEO weekly — ${rankingCount}/${r.targets.length} money terms ranking, ${gainers.length} up / ${losers.length} down`;

  // Slack
  const S: string[] = [`*📈 Snagged SEO — weekly*  <${link}|open report>`];
  if (r.headToHead.ours && r.headToHead.competitor) {
    const o = r.headToHead.ours, c = r.headToHead.competitor;
    S.push(`Head-to-head: *DR ${o.dr ?? "—"}* vs ${c.dr ?? "—"} · organic ~${o.org_traffic}/mo vs ~${c.org_traffic}/mo (${c.domain})`);
  }
  if (gainers.length) S.push(`*Gaining distance:*\n${gainers.map((t) => `• ${t.keyword} — pos ${pos(t.position)} (${arrow(t.delta)})`).join("\n")}`);
  if (losers.length) S.push(`*Losing distance:*\n${losers.map((t) => `• ${t.keyword} — pos ${pos(t.position)} (${arrow(t.delta)})`).join("\n")}`);
  if (notRanking.length) S.push(`*Not ranking yet:* ${notRanking.map((t) => t.keyword).join(", ")}`);
  if (openActions.length) S.push(`*Open actions (${openActions.length}):*\n${openActions.slice(0, 6).map((a) => `• ${a.title}`).join("\n")}`);

  // Email
  const rows = (arr: typeof ranked) => arr.map((t) => `<tr><td style="padding:4px 10px 4px 0">${t.keyword}</td><td style="padding:4px 10px;text-align:right">${pos(t.position)}</td><td style="padding:4px 10px;text-align:right">${arrow(t.delta)}</td><td style="padding:4px 10px;text-align:right">${t.volume ?? "—"}</td><td style="padding:4px 10px;text-align:right">${pos(t.competitor_position)}</td></tr>`).join("");
  const html = `
    <div style="font-family:system-ui,Arial,sans-serif;max-width:680px">
      <h2 style="margin:0 0 4px">📈 Snagged SEO — weekly</h2>
      <p style="color:#555;margin:0 0 14px">${rankingCount}/${r.targets.length} money terms have impressions · ${gainers.length} gaining · ${losers.length} losing · ${openActions.length} open actions</p>
      ${r.headToHead.ours && r.headToHead.competitor ? `<p style="margin:0 0 14px">Head-to-head — <b>DR ${r.headToHead.ours.dr ?? "—"}</b> vs ${r.headToHead.competitor.dr ?? "—"}; organic ~${r.headToHead.ours.org_traffic}/mo vs ~${r.headToHead.competitor.org_traffic}/mo (${r.headToHead.competitor.domain}).</p>` : ""}
      <table style="border-collapse:collapse;font-size:14px;width:100%">
        <thead><tr style="text-align:left;color:#777"><th style="padding:4px 10px 4px 0">Money term</th><th style="padding:4px 10px;text-align:right">Pos</th><th style="padding:4px 10px;text-align:right">WoW</th><th style="padding:4px 10px;text-align:right">Vol</th><th style="padding:4px 10px;text-align:right">Competitor</th></tr></thead>
        <tbody>${rows(ranked)}</tbody>
      </table>
      ${openActions.length ? `<h3 style="margin:18px 0 6px">Open actions</h3><ul style="margin:0;padding-left:18px">${openActions.slice(0, 8).map((a) => `<li>${a.title}${a.keyword ? ` <span style="color:#888">(${a.keyword})</span>` : ""}</li>`).join("")}</ul>` : ""}
      <p style="margin:18px 0 0"><a href="${link}">Open the SEO report →</a></p>
    </div>`;

  return { subject, slack: S.join("\n\n"), html, report: r };
}
