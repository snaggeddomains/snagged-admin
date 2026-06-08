"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarList, TrendChart, FunnelChart, type Bar } from "./analytics-charts";

// ── Types mirror lib/ga.ts + lib/revenue.ts ─────────────────────────────────
type Tranche = "core" | "marketplace" | "blog" | "seo" | "revenue" | "email";
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type ChannelRow = { channel: string; sessions: number; users: number };
type PageRow = { path: string; views: number; users: number };
type SourceRow = { source: string; medium: string; sessions: number };
type LabelValue = { label: string; value: number };
type TrendRow = { date: string; sessions: number; pageviews: number };
type FunnelStep = { name: string; users: number };
type MarketplaceReport = { summary: StatBlock; topPages: PageRow[]; channels: ChannelRow[]; trend: TrendRow[] };
type CoreReport = {
  summary: StatBlock; channels: ChannelRow[]; sources: SourceRow[];
  submissionsByChannel: LabelValue[]; selfReportedSource: LabelValue[]; leadIntent: LabelValue[]; leadBudget: LabelValue[]; trend: TrendRow[];
};
type BlogReport = { summary: StatBlock; topPosts: PageRow[]; channels: ChannelRow[]; sources: SourceRow[]; funnel: FunnelStep[]; trend: TrendRow[] };
type RevenueReport = {
  totalRevenue: number; payments: number; upfront: { count: number; amount: number }; success: { count: number; amount: number };
  other: { count: number; amount: number }; byType: LabelValue[]; byOwner: LabelValue[]; monthly: { month: string; amount: number }[];
};
type SeoRow = { key: string; clicks: number; impressions: number; ctr: number; position: number };
type SeoTrend = { date: string; clicks: number; impressions: number };
type SeoBucket = "all" | "core" | "marketplace" | "blog";
type SeoReport = { bucket: SeoBucket; totals: { clicks: number; impressions: number; ctr: number; position: number }; topQueries: SeoRow[]; topPages: SeoRow[]; trend: SeoTrend[] };
type Campaign = { title: string; sendTime: string; sent: number; openRate: number; clickRate: number };
type GrowthPoint = { month: string; optins: number; subscribed: number };
type NewsletterReport = { audience: string; subscribers: number; unsubscribes: number; cleaned: number; openRate: number; clickRate: number; netSinceLastSend: number; campaigns: Campaign[]; growth: GrowthPoint[] };
type DayCount = { date: string; count: number };
type EmailReport = { newsletter: NewsletterReport | null; signups: DayCount[]; unsubs: DayCount[]; through: string; live?: boolean };

type Preset = "today" | "week" | "month" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "custom", label: "Custom range" },
];
const TRANCHES: { key: Tranche; label: string }[] = [
  { key: "core", label: "Core Services" }, { key: "marketplace", label: "Marketplace" }, { key: "blog", label: "Blog" }, { key: "seo", label: "SEO" }, { key: "email", label: "Email" }, { key: "revenue", label: "Revenue" },
];
const QUALITY_BUDGETS = ["$25K to $100K", "$100K+"]; // tunable; v1 quality-lead definition

const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000));
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const fmt = (x: number) => x.toLocaleString();
const usd = (x: number) => `$${Math.round(x).toLocaleString()}`;
const CORAL = "var(--coral-deep, #c0492f)";

function StatCard({ label, value, sub, accent, text }: { label: string; value?: number; sub?: string; accent?: boolean; text?: string }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? CORAL : "var(--navy, #254254)" }}>{text ?? fmt(value ?? 0)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{label}{sub && <span style={{ display: "block", fontSize: 10 }}>{sub}</span>}</div>
    </div>
  );
}

function Section({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 22 }}>
      <h2 style={{ fontSize: 17 }}>{title}</h2>
      {blurb && <p className="section-blurb" style={{ marginTop: 0 }}>{blurb}</p>}
      {children}
    </section>
  );
}

const SEO_BUCKETS: { key: SeoBucket; label: string }[] = [
  { key: "all", label: "All" }, { key: "core", label: "Core" }, { key: "marketplace", label: "Marketplace" }, { key: "blog", label: "Blog" },
];

export default function AnalyticsClient({ canCost }: { canCost: boolean }) {
  const [tranche, setTranche] = useState<Tranche>("core");
  const [seoBucket, setSeoBucket] = useState<SeoBucket>("all");
  const [preset, setPreset] = useState<Preset>("week");
  const [from, setFrom] = useState(WEEK_START);
  const [to, setTo] = useState(TODAY);
  const [loaded, setLoaded] = useState<{ tranche: Tranche; report: unknown } | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const range = useMemo(() => {
    if (preset === "today") return { from: TODAY, to: TODAY };
    if (preset === "week") return { from: WEEK_START, to: TODAY };
    if (preset === "month") return { from: MONTH_START, to: TODAY };
    return { from, to: to || from };
  }, [preset, from, to]);

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const q = new URLSearchParams({ tranche, from: range.from, to: range.to });
      if (tranche === "seo") q.set("bucket", seoBucket);
      const res = await fetch(`/api/admin/analytics?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.configured === false) { setConfigured(false); setLoaded(null); setMsg(data.error || "Not configured."); return; }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setConfigured(true); setLoaded({ tranche: data.tranche, report: data.report });
    } catch (e) { setMsg(String((e as Error).message || e)); } finally { setLoading(false); }
  }, [tranche, seoBucket, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Site analytics</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        snagged.com performance, split by business: <strong>Core Services</strong> (the sell-side),{" "}
        <strong>Marketplace</strong> (<code>/domains/*</code> type-in buyers), <strong>Blog / SEO</strong> (content driving
        organic traffic), and <strong>Revenue</strong> (the Domain Tracker). Pre-June submission data is the historical
        Formspark export; everything forward is live from GA.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3, flexWrap: "wrap" }}>
          {TRANCHES.map((t) => (
            <button key={t.key} onClick={() => setTranche(t.key)} style={{
              padding: "5px 14px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer",
              background: tranche === t.key ? "var(--navy, #254254)" : "transparent", color: tranche === t.key ? "#fff" : "var(--navy, #254254)",
            }}>{t.label}</button>
          ))}
        </div>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          Window
          <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="field" style={{ padding: "5px 8px", fontSize: 13 }}>
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {preset === "custom" && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)} className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)} className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
          </span>
        )}
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 13 }}>{rangeLabel}</span>
      </div>

      {tranche === "seo" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 12 }}>Search by business line:</span>
          <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3 }}>
            {SEO_BUCKETS.map((b) => (
              <button key={b.key} onClick={() => setSeoBucket(b.key)} style={{
                padding: "4px 12px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer",
                background: seoBucket === b.key ? "var(--coral-deep, #c0492f)" : "transparent", color: seoBucket === b.key ? "#fff" : "var(--navy, #254254)",
              }}>{b.label}</button>
            ))}
          </div>
        </div>
      )}

      {msg && <p style={{ fontSize: 13, color: CORAL }}>{msg}</p>}

      {!configured ? (
        <p className="muted">Not configured for this deployment. Set <code>GA4_PROPERTY_ID</code> and <code>GOOGLE_SA_KEY</code> in the project env, then refresh.</p>
      ) : !loaded && loading ? (
        <p className="muted">Loading…</p>
      ) : loaded ? (
        loaded.tranche === "marketplace" ? <MarketplaceView r={loaded.report as MarketplaceReport} />
          : loaded.tranche === "blog" ? <BlogView r={loaded.report as BlogReport} />
            : loaded.tranche === "seo" ? <SeoView r={loaded.report as SeoReport} />
              : loaded.tranche === "email" ? <EmailView r={loaded.report as EmailReport} />
                : loaded.tranche === "revenue" ? <RevenueView r={loaded.report as RevenueReport} />
                  : <CoreView r={loaded.report as CoreReport} />
      ) : (
        <p className="muted">No data for this window.</p>
      )}

      {loaded && (loaded.tranche === "core" || loaded.tranche === "marketplace" || loaded.tranche === "blog") && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>
          Source: GA4 Data API (timezone America/New_York). Submissions blend the historical Formspark export (through
          2026-06-07) with GA conversion events (forward). Self-reported source / intent / budget come from form fields —
          historical from the export, live from GA event params once the matching custom dimensions are registered.
        </p>
      )}
      {loaded && loaded.tranche === "revenue" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>Source: Snagged Domain Tracker (Payments tab), aggregated by Client Paid Date over the window.</p>
      )}
      {loaded && loaded.tranche === "seo" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>Source: Google Search Console (snagged.com). Search data lags ~2 days, so the most recent day or two of a window may read low.</p>
      )}
      {loaded && loaded.tranche === "email" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>Source: Mailchimp (largest audience). Audience totals are current; campaigns are those sent within the selected window.</p>
      )}
    </main>
  );
}

function MarketplaceView({ r }: { r: MarketplaceReport }) {
  const s = r.summary;
  const pageBars: Bar[] = r.topPages.slice(0, 15).map((p) => ({ label: p.path.replace(/^\/domains\//, ""), value: p.views, href: `https://www.snagged.com${p.path}` }));
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Sessions" value={s.sessions} /><StatCard label="Users" value={s.users} />
        <StatCard label="Pageviews" value={s.pageviews} /><StatCard label="Inquiries (form)" value={s.submissions} accent />
      </div>
      <Section title="Top pages by views" blurb="Which domain listings are getting looked at most."><BarList rows={pageBars} /></Section>
      <Section title="Traffic by channel" blurb="How marketplace visitors arrive (mostly Direct — type-ins)."><BarList rows={r.channels.map((c) => ({ label: c.channel, value: c.sessions }))} showShare /></Section>
      <Section title="Daily trend"><TrendChart data={r.trend} /></Section>
    </>
  );
}

function CoreView({ r }: { r: CoreReport }) {
  const s = r.summary;
  const quality = r.leadBudget.filter((b) => QUALITY_BUDGETS.includes(b.label)).reduce((a, b) => a + b.value, 0);
  const sourceBars: Bar[] = r.sources.slice(0, 12).map((x) => ({ label: x.source === "(direct)" ? "direct" : `${x.source} / ${x.medium}`, value: x.sessions }));
  const pending = "Populates from the historical export + GA once the matching custom dimension is registered.";
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Sessions" value={s.sessions} /><StatCard label="Users" value={s.users} />
        <StatCard label="Leads (form)" value={s.submissions} accent /><StatCard label="Quality leads" sub="budget ≥ $25K" value={quality} accent />
      </div>
      <Section title="Where traffic comes from" blurb="The sell-side is multi-channel — this is where source detail matters."><BarList rows={r.channels.map((c) => ({ label: c.channel, value: c.sessions }))} showShare /></Section>
      <Section title="Top sources" blurb="Source / medium behind the channels above."><BarList rows={sourceBars} /></Section>
      <Section title="Form submissions by channel" blurb="Which channels produce leads (GA generate_lead)."><BarList rows={r.submissionsByChannel.map((x) => ({ label: x.label, value: x.value }))} color={CORAL} empty="No GA-tracked submissions yet in this window." /></Section>
      <Section title="Self-reported source" blurb='"How did you hear about Snagged?" — the truest attribution we have.'><BarList rows={r.selfReportedSource.map((x) => ({ label: x.label, value: x.value }))} color={CORAL} empty={pending} /></Section>
      <Section title="Lead intent" blurb="Acquire vs sell, off the form's intent select."><BarList rows={r.leadIntent.map((x) => ({ label: x.label, value: x.value }))} empty={pending} /></Section>
      <Section title="Lead budget" blurb="Budget mix — quality leads are the top two bands (definition will evolve toward engagement)."><BarList rows={r.leadBudget.map((x) => ({ label: x.label, value: x.value }))} empty={pending} /></Section>
      <Section title="Daily trend"><TrendChart data={r.trend} /></Section>
    </>
  );
}

function BlogView({ r }: { r: BlogReport }) {
  const s = r.summary;
  const organic = r.channels.find((c) => /organic search/i.test(c.channel))?.sessions ?? 0;
  const postBars: Bar[] = r.topPosts.slice(0, 15).map((p) => ({ label: p.path.replace(/^\/(post|blog|guides)\/?/, "") || p.path, value: p.views, href: `https://www.snagged.com${p.path}` }));
  const sourceBars: Bar[] = r.sources.slice(0, 12).map((x) => ({ label: x.source === "(direct)" ? "direct" : `${x.source} / ${x.medium}`, value: x.sessions }));
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Sessions" value={s.sessions} /><StatCard label="Users" value={s.users} />
        <StatCard label="Organic search" sub="SEO sessions" value={organic} accent /><StatCard label="Pageviews" value={s.pageviews} />
      </div>
      <Section title="Top posts by views" blurb="Which content is pulling traffic."><BarList rows={postBars} /></Section>
      <Section title="Blog → site → submission funnel" blurb="Visitors who entered on a blog post, reached the main site, then submitted a lead — the SEO-to-conversion path you care about.">
        <FunnelChart steps={r.funnel} />
      </Section>
      <Section title="Traffic by channel" blurb="How blog visitors arrive — Organic Search is the SEO signal."><BarList rows={r.channels.map((c) => ({ label: c.channel, value: c.sessions }))} showShare /></Section>
      <Section title="Top sources" blurb="Search engines / referrers sending blog traffic."><BarList rows={sourceBars} /></Section>
      <Section title="Daily trend"><TrendChart data={r.trend} /></Section>
    </>
  );
}

function RevenueView({ r }: { r: RevenueReport }) {
  const monthBars: Bar[] = r.monthly.map((m) => ({ label: m.month, value: m.amount }));
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Total revenue" text={usd(r.totalRevenue)} accent />
        <StatCard label="Payments" value={r.payments} />
        <StatCard label="Upfront fees" sub={`${r.upfront.count} payments`} text={usd(r.upfront.amount)} />
        <StatCard label="Success fees" sub={`${r.success.count} deals`} text={usd(r.success.amount)} accent />
      </div>
      <Section title="Revenue by type" blurb="Upfront engagement fees vs success fees on closed acquisitions."><BarList rows={r.byType.map((x) => ({ label: x.label, value: x.value }))} money empty="No payments in this window." /></Section>
      <Section title="Revenue by month" blurb="Monthly take over the window (by Client Paid Date)."><BarList rows={monthBars} money color={CORAL} empty="No payments in this window." /></Section>
      <Section title="By owner / lead" blurb="Who's bringing in the revenue."><BarList rows={r.byOwner.map((x) => ({ label: x.label, value: x.value }))} money empty="No payments in this window." /></Section>
    </>
  );
}

function SeoTable({ rows, head, link }: { rows: SeoRow[]; head: string; link?: boolean }) {
  if (!rows.length) return <p className="muted" style={{ fontSize: 13 }}>No search data in this window.</p>;
  return (
    <div className="table-scroll"><table className="dash">
      <thead><tr><th>{head}</th><th className="right">clicks</th><th className="right">impr</th><th className="right">CTR</th><th className="right">avg pos</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="mono">{link ? <a href={r.key} target="_blank" rel="noreferrer">{r.key.replace(/^https?:\/\/(www\.)?snagged\.com/, "") || r.key}</a> : r.key}</td>
            <td className="right">{fmt(r.clicks)}</td>
            <td className="right muted">{fmt(r.impressions)}</td>
            <td className="right muted">{(r.ctr * 100).toFixed(1)}%</td>
            <td className="right muted">{r.position.toFixed(1)}</td>
          </tr>
        ))}
      </tbody>
    </table></div>
  );
}

function SeoView({ r }: { r: SeoReport }) {
  const t = r.totals;
  const trend = r.trend.map((x) => ({ date: x.date, sessions: x.clicks, pageviews: x.impressions }));
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Clicks" value={t.clicks} accent />
        <StatCard label="Impressions" value={t.impressions} />
        <StatCard label="CTR" text={`${(t.ctr * 100).toFixed(1)}%`} />
        <StatCard label="Avg position" text={t.position ? t.position.toFixed(1) : "—"} />
      </div>
      <Section title="Clicks & impressions trend"><TrendChart data={trend} labels={["Clicks", "Impressions"]} /></Section>
      <Section title="Top search queries" blurb="What people search to find this part of the site (and where you rank)."><SeoTable rows={r.topQueries} head="query" /></Section>
      <Section title="Top pages from search" blurb="Which pages pull search clicks."><SeoTable rows={r.topPages} head="page" link /></Section>
    </>
  );
}

// Roll daily counts up to the chosen granularity, then merge signups + unsubs into
// a single trend series (signups = the solid line, unsubs = the dashed line).
function weekKey(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7)); // back to Monday
  return dt.toISOString().slice(0, 10);
}
function bucketKey(date: string, gran: "day" | "week" | "month"): string {
  return gran === "month" ? date.slice(0, 7) : gran === "week" ? weekKey(date) : date;
}
function combineSeries(signups: DayCount[], unsubs: DayCount[], gran: "day" | "week" | "month"): TrendRow[] {
  const m = new Map<string, { s: number; u: number }>();
  for (const { date, count } of signups) { const k = bucketKey(date, gran); const o = m.get(k) || { s: 0, u: 0 }; o.s += count; m.set(k, o); }
  for (const { date, count } of unsubs) { const k = bucketKey(date, gran); const o = m.get(k) || { s: 0, u: 0 }; o.u += count; m.set(k, o); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, v]) => ({ date, sessions: v.s, pageviews: v.u }));
}
// Roll a single daily series up to the selected granularity → bars (per-period counts).
function rollupBars(daily: DayCount[], gran: "day" | "week" | "month"): Bar[] {
  const m = new Map<string, number>();
  for (const { date, count } of daily) { const k = bucketKey(date, gran); m.set(k, (m.get(k) || 0) + count); }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([label, value]) => ({ label, value }));
}

function EmailView({ r }: { r: EmailReport }) {
  const [gran, setGran] = useState<"day" | "week" | "month">("month");
  const nl = r.newsletter;
  const totalSignups = r.signups.reduce((a, b) => a + b.count, 0);
  const totalUnsubs = r.unsubs.reduce((a, b) => a + b.count, 0);
  const trend = combineSeries(r.signups, r.unsubs, gran);
  return (
    <>
      {nl && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Subscribers" sub={nl.audience} value={nl.subscribers} accent />
          <StatCard label="Avg open rate" text={`${(nl.openRate * 100).toFixed(1)}%`} />
          <StatCard label="Avg click rate" text={`${(nl.clickRate * 100).toFixed(1)}%`} />
          <StatCard label="Net since last send" value={nl.netSinceLastSend} accent />
        </div>
      )}

      <Section title="Signups & unsubscribes" blurb={r.live
        ? `Auto-refreshed from Mailchimp — historical export seed + live opt-ins/unsubscribes through ${r.through}.`
        : `New opt-ins vs unsubscribes over the window. History through ${r.through} (audience export).`}>
        <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap" }}>
          <StatCard label="New signups" value={totalSignups} accent />
          <StatCard label="Unsubscribes" value={totalUnsubs} />
          <StatCard label="Net adds" value={totalSignups - totalUnsubs} accent />
          <div style={{ marginLeft: "auto", display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3, alignSelf: "center" }}>
            {(["day", "week", "month"] as const).map((g) => (
              <button key={g} onClick={() => setGran(g)} style={{
                padding: "4px 12px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer", textTransform: "capitalize",
                background: gran === g ? "var(--navy, #254254)" : "transparent", color: gran === g ? "#fff" : "var(--navy, #254254)",
              }}>{g}</button>
            ))}
          </div>
        </div>
        {/* New signups by the selected period — the headline chart. */}
        <h3 style={{ fontSize: 14, margin: "4px 0 8px" }}>New signups by {gran}</h3>
        <BarList rows={rollupBars(r.signups, gran)} color={CORAL} empty="No signups in this window." />
        {/* Signups vs unsubscribes trend overlay. */}
        <h3 style={{ fontSize: 14, margin: "18px 0 8px" }}>Signups vs unsubscribes — trend</h3>
        <TrendChart data={trend} labels={["New signups", "Unsubscribes"]} />
      </Section>

      {nl && (
        <Section title="Recent campaigns" blurb="Email performance for sends in this window.">
          {nl.campaigns.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No campaigns sent in this window.</p> : (
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>campaign</th><th className="right">sent</th><th className="right">date</th><th className="right">open</th><th className="right">click</th></tr></thead>
              <tbody>
                {nl.campaigns.map((c, i) => (
                  <tr key={c.title + i}>
                    <td>{c.title}</td>
                    <td className="right">{fmt(c.sent)}</td>
                    <td className="right muted">{c.sendTime}</td>
                    <td className="right muted">{(c.openRate * 100).toFixed(1)}%</td>
                    <td className="right muted">{(c.clickRate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Section>
      )}
    </>
  );
}
