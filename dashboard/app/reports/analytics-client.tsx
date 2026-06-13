"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BarList, TrendChart, FunnelChart, Sparkline, type Bar } from "./analytics-charts";

// ── Types mirror lib/ga.ts + lib/revenue.ts ─────────────────────────────────
type Tranche = "core" | "marketplace" | "blog" | "seo" | "revenue" | "email" | "ads";
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type ChannelRow = { channel: string; sessions: number; users: number };
type PageRow = { path: string; views: number; users: number };
type SourceRow = { source: string; medium: string; sessions: number };
type LabelValue = { label: string; value: number };
type TrendRow = { date: string; sessions: number; pageviews: number };
type FunnelStep = { name: string; users: number };
type CoreReport = {
  summary: StatBlock; channels: ChannelRow[]; sources: SourceRow[];
  submissionsByChannel: LabelValue[]; selfReportedSource: LabelValue[]; leadIntent: LabelValue[]; leadBudget: LabelValue[]; trend: TrendRow[];
};
type BlogReport = { summary: StatBlock; topPosts: PageRow[]; channels: ChannelRow[]; sources: SourceRow[]; funnel: FunnelStep[]; trend: TrendRow[] };
type RevenueReport = {
  totalRevenue: number; gross: number; snaggedCost: number; payments: number; upfront: { count: number; amount: number }; success: { count: number; amount: number };
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
type XAdsCampaign = { id: string; name: string; status: string; spend: number; impressions: number; clicks: number; engagements: number; cpc: number };
type XAdsDaily = { date: string; spend: number; impressions: number; clicks: number };
type XAdsTotals = { spend: number; impressions: number; clicks: number; engagements: number; cpc: number; cpm: number; ctr: number };
type XAdsRoi = { leads: number | null; totalLeads: number | null; costPerLead: number | null; gaConfigured: boolean };
type LiftChannel = { channel: string; baselinePerDay: number; adPerDay: number; incrementalVisits: number };
type XAdsLift = { from: string; to: string; lookbackDays: number; adDays: number; offDays: number; spend: number; channels: LiftChannel[]; defaultChannels: string[] };
type AdsReport = { totals: XAdsTotals; byCampaign: XAdsCampaign[]; trend: XAdsDaily[]; roi: XAdsRoi; campaignCount: number };

type Preset = "today" | "yesterday" | "week" | "lastweek" | "month" | "lastmonth" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" }, { key: "lastweek", label: "Last week" },
  { key: "month", label: "This month" }, { key: "lastmonth", label: "Last month" }, { key: "custom", label: "Custom range" },
];
const TRANCHES: { key: Tranche; label: string }[] = [
  { key: "core", label: "Core Services" }, { key: "blog", label: "Blog" }, { key: "seo", label: "SEO" }, { key: "email", label: "Email" }, { key: "ads", label: "Ads" }, { key: "revenue", label: "Revenue" },
];
const QUALITY_BUDGETS = ["$25K to $100K", "$100K+"]; // tunable; v1 quality-lead definition

const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const YESTERDAY = etYmd(new Date(Date.now() - 86400000));
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000));
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
// Last week = the 7 days before this rolling week; last month = the previous
// calendar month (UTC calendar math — these are dates, not instants).
const LAST_WEEK_START = etYmd(new Date(Date.now() - 13 * 86400000));
const LAST_WEEK_END = etYmd(new Date(Date.now() - 7 * 86400000));
const _ty = Number(TODAY.slice(0, 4)), _tm = Number(TODAY.slice(5, 7));
const _lmEnd = new Date(Date.UTC(_ty, _tm - 1, 0)); // day 0 of this month = last day of prev month
const pad2 = (x: number) => String(x).padStart(2, "0");
const LAST_MONTH_END = `${_lmEnd.getUTCFullYear()}-${pad2(_lmEnd.getUTCMonth() + 1)}-${pad2(_lmEnd.getUTCDate())}`;
const LAST_MONTH_START = `${_lmEnd.getUTCFullYear()}-${pad2(_lmEnd.getUTCMonth() + 1)}-01`;
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
    if (preset === "yesterday") return { from: YESTERDAY, to: YESTERDAY };
    if (preset === "week") return { from: WEEK_START, to: TODAY };
    if (preset === "lastweek") return { from: LAST_WEEK_START, to: LAST_WEEK_END };
    if (preset === "month") return { from: MONTH_START, to: TODAY };
    if (preset === "lastmonth") return { from: LAST_MONTH_START, to: LAST_MONTH_END };
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
    } catch (e) { setLoaded(null); setMsg(String((e as Error).message || e)); } finally { setLoading(false); }
  }, [tranche, seoBucket, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Site analytics</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        snagged.com performance, split by business: <strong>Core Services</strong> (the sell-side),{" "}
        <strong>Blog / SEO</strong> (content driving
        organic traffic), <strong>Ads</strong> (X spend &amp; cost-per-lead — X is our #1 lead source), and{" "}
        <strong>Revenue</strong> (the Domain Tracker). Pre-June submission data is the historical
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
      ) : loading ? (
        <p className="muted">Loading…</p>
      ) : loaded && loaded.tranche === tranche ? (
        loaded.tranche === "blog" ? <BlogView r={loaded.report as BlogReport} />
            : loaded.tranche === "seo" ? <SeoView r={loaded.report as SeoReport} />
              : loaded.tranche === "email" ? <EmailView r={loaded.report as EmailReport} />
                : loaded.tranche === "ads" ? <AdsView r={loaded.report as AdsReport} range={range} />
                  : loaded.tranche === "revenue" ? <RevenueView r={loaded.report as RevenueReport} />
                    : <CoreView r={loaded.report as CoreReport} />
      ) : (
        <p className="muted">No data for this window.</p>
      )}

      {loaded && (loaded.tranche === "core" || loaded.tranche === "blog") && (
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
      {loaded && loaded.tranche === "ads" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>Source: X (Twitter) Ads API (account timezone America/New_York), spend billed in USD. Cost-per-lead pairs X spend with X-attributed leads from the core funnel (&quot;How did you hear about Snagged? → X / Twitter&quot;, blending the historical export with live GA), so it reads low until self-reported source data lands for the window.</p>
      )}
    </main>
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
        <StatCard label="Net revenue" sub={r.snaggedCost ? `${usd(r.gross)} gross − ${usd(r.snaggedCost)} cost` : "gross − Snagged cost"} text={usd(r.totalRevenue)} accent />
        <StatCard label="Payments" value={r.payments} />
        <StatCard label="Upfront fees" sub={`${r.upfront.count} payments`} text={usd(r.upfront.amount)} />
        <StatCard label="Success fees" sub={`${r.success.count} deals · net`} text={usd(r.success.amount)} accent />
        <StatCard label="Snagged cost" sub="fronted & reimbursed" text={usd(r.snaggedCost)} />
      </div>
      <Section title="Revenue by type" blurb="Upfront engagement fees vs success fees on closed acquisitions."><BarList rows={r.byType.map((x) => ({ label: x.label, value: x.value }))} money empty="No payments in this window." /></Section>
      <Section title="Revenue by month" blurb="Monthly take over the window (by Client Paid Date)."><BarList rows={monthBars} money color={CORAL} empty="No payments in this window." /></Section>
      <Section title="By owner / lead" blurb="Who's bringing in the revenue."><BarList rows={r.byOwner.map((x) => ({ label: x.label, value: x.value }))} money empty="No payments in this window." /></Section>
    </>
  );
}

function AdsView({ r, range }: { r: AdsReport; range: { from: string; to: string } }) {
  const t = r.totals;
  const roi = r.roi;
  const campaignBars: Bar[] = r.byCampaign.slice(0, 15).map((c) => ({ label: c.name, value: c.spend }));
  const spendTrend = r.trend.map((d) => ({ date: d.date, sessions: Math.round(d.spend), pageviews: d.clicks }));
  const cplText = roi.costPerLead != null ? usd(roi.costPerLead) : "—";
  const cplSub = roi.leads != null
    ? `${fmt(roi.leads)} X lead${roi.leads === 1 ? "" : "s"} · spend ÷ leads`
    : roi.gaConfigured ? "No X-attributed leads in window" : "GA not configured";
  const leadShare = roi.leads != null && roi.totalLeads ? Math.round((roi.leads / roi.totalLeads) * 100) : null;
  return (
    <>
      {/* ROI headline — the reason this tab exists: X is the #1 lead source, so
          what are we paying per lead? */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Cost per X lead" sub={cplSub} text={cplText} accent />
        <StatCard label="Ad spend" text={usd(t.spend)} accent />
        <StatCard label="X-attributed leads" sub={leadShare != null ? `${leadShare}% of self-reported` : "self-reported source"} text={roi.leads != null ? fmt(roi.leads) : "—"} accent />
        <StatCard label="Clicks" value={t.clicks} />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <StatCard label="Impressions" value={t.impressions} />
        <StatCard label="Engagements" value={t.engagements} />
        <StatCard label="CPC" sub="cost per click" text={t.clicks ? usd(t.cpc) : "—"} />
        <StatCard label="CPM" sub="cost / 1k impr" text={t.impressions ? usd(t.cpm) : "—"} />
        <StatCard label="CTR" text={t.impressions ? `${(t.ctr * 100).toFixed(2)}%` : "—"} />
      </div>
      <Section title="Spend by campaign" blurb={`Where the X budget went${r.campaignCount ? ` (${r.campaignCount} campaign${r.campaignCount === 1 ? "" : "s"} active in the window)` : ""}.`}>
        <BarList rows={campaignBars} money color={CORAL} empty="No campaign spend in this window." />
      </Section>
      <Section title="Daily spend & clicks" blurb="Spend (area, $) against clicks (dashed) over the window.">
        <TrendChart data={spendTrend} labels={["Spend ($)", "Clicks"]} />
      </Section>
      <LeadsLoader range={range} />
      <EffectivenessLoader range={range} />
      <LiftLoader to={range.to} />
      {r.byCampaign.length > 0 && (
        <Section title="Campaign detail" blurb="Per-campaign spend, reach and efficiency.">
          <div className="table-scroll"><table className="dash">
            <thead><tr><th>campaign</th><th>status</th><th className="right">spend</th><th className="right">impr</th><th className="right">clicks</th><th className="right">CPC</th></tr></thead>
            <tbody>
              {r.byCampaign.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td className="muted">{c.status.toLowerCase()}</td>
                  <td className="right">{usd(c.spend)}</td>
                  <td className="right muted">{fmt(c.impressions)}</td>
                  <td className="right muted">{fmt(c.clicks)}</td>
                  <td className="right muted">{c.clicks ? usd(c.cpc) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Section>
      )}
    </>
  );
}

// ── Effectiveness (per-campaign + per-ad) ────────────────────────────────────
type EffWeek = { week: string; ctr: number; spend: number; impressions: number };
type EffRow = {
  id: string; name: string; campaign: string; status: string; firstDay: string; lastDay: string;
  daysActive: number; spend: number; impressions: number; clicks: number; engagements: number;
  ctr: number; cpc: number; cpm: number; cpe: number; engRate: number; weekly: EffWeek[];
};
type XAdsEffectiveness = { from: string; to: string; campaigns: EffRow[]; ads: EffRow[]; coverage: { adSpend: number; campaignSpend: number } };

// CTR degradation = last vs first active week (negative = fatiguing).
function degradation(weekly: EffWeek[]): number | null {
  const live = weekly.filter((w) => w.impressions > 0);
  if (live.length < 2) return null;
  const first = live[0].ctr, last = live[live.length - 1].ctr;
  if (!first) return null;
  return (last - first) / first;
}

function EffTable({ rows, kind }: { rows: EffRow[]; kind: "campaign" | "ad" }) {
  if (!rows.length) return <p className="muted" style={{ fontSize: 13 }}>No {kind} activity in this window.</p>;
  return (
    <div className="table-scroll"><table className="dash">
      <thead><tr>
        <th>{kind === "ad" ? "ad (tweet)" : "campaign"}</th>
        <th className="right">days</th><th className="right">spend</th><th className="right">impr</th>
        <th className="right">CTR</th><th className="right">CPC</th><th className="right">CPE</th>
        <th className="right">eng rate</th><th className="right">CTR trend</th><th className="right">Δ CTR</th>
      </tr></thead>
      <tbody>
        {rows.map((r) => {
          const deg = degradation(r.weekly);
          return (
            <tr key={r.id}>
              <td title={r.name + (r.campaign ? ` — ${r.campaign}` : "")} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}{kind === "ad" && r.campaign && <span className="muted" style={{ display: "block", fontSize: 10 }}>{r.campaign}</span>}
              </td>
              <td className="right muted">{r.daysActive}</td>
              <td className="right">{usd(r.spend)}</td>
              <td className="right muted">{fmt(r.impressions)}</td>
              <td className="right">{(r.ctr * 100).toFixed(2)}%</td>
              <td className="right muted">{r.clicks ? usd(r.cpc) : "—"}</td>
              <td className="right muted">{r.engagements ? `$${r.cpe.toFixed(2)}` : "—"}</td>
              <td className="right muted">{(r.engRate * 100).toFixed(1)}%</td>
              <td className="right"><span style={{ display: "inline-block" }}><Sparkline values={r.weekly.map((w) => w.ctr)} color={CORAL} /></span></td>
              <td className="right" style={{ color: deg == null ? undefined : deg >= 0 ? "#2e7d32" : CORAL, fontWeight: 600 }}>
                {deg == null ? "—" : `${deg >= 0 ? "+" : ""}${Math.round(deg * 100)}%`}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table></div>
  );
}

// ── Leads (actual contact-form submissions) ─────────────────────────────────
type LeadMatch = { dealName: string; contact: string | null; status: string | null; acquisitionPrice: number | null; clientPaid: number | null; via: "email" | "name" | "domain" };
type Lead = { date: string; name: string; email: string; domains: string[]; source: string | null; intent: string | null; budget: string | null; location: string | null; message: string | null; match: LeadMatch | null };
type LeadsReport = { configured: boolean; total: number; matched: number; bySource: LabelValue[]; leads: Lead[] };

// The real leads behind the X-attributed count — name, email, domains of interest,
// self-reported source — parsed from the inquiry@ submission emails, with a
// best-effort revenue tie-back. Lazy-loaded (Gmail + Sheets) like lift/effectiveness.
function LeadsLoader({ range }: { range: { from: string; to: string } }) {
  const [data, setData] = useState<LeadsReport | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [msg, setMsg] = useState("");
  const [src, setSrc] = useState<string>("X / Twitter"); // default to the X leads (this is the Ads tab)
  useEffect(() => {
    let live = true;
    setState("loading"); setMsg("");
    (async () => {
      try {
        const res = await fetch(`/api/admin/analytics?tranche=ads&part=leads&from=${range.from}&to=${range.to}`, { cache: "no-store" });
        const json = JSON.parse(await res.text());
        if (!live) return;
        if (!res.ok || json.ok === false) throw new Error(json.error || `Failed (${res.status})`);
        setData(json.leads || null); setState("done");
      } catch (e) {
        if (live) { setState("error"); setMsg(String((e as Error).message || e)); }
      }
    })();
    return () => { live = false; };
  }, [range.from, range.to]);

  const blurb = "The actual contact-form submissions behind the lead count — name, email, domains of interest and self-reported source, parsed from the inquiry@ notification emails. The 💰 badge ties a lead back to a deal on the Tracker (matched by email → name → domain).";
  if (state === "loading") return <Section title="Leads" blurb={blurb}><p className="muted" style={{ fontSize: 13 }}>Loading leads…</p></Section>;
  if (state === "error") return <Section title="Leads" blurb={blurb}><p className="muted" style={{ fontSize: 13 }}>Couldn&apos;t load leads ({msg}). Needs the read-only Gmail integration (GOOGLE_SA_KEY) configured.</p></Section>;
  if (!data || !data.configured) return <Section title="Leads" blurb={blurb}><p className="muted" style={{ fontSize: 13 }}>Leads need the read-only Gmail integration configured.</p></Section>;

  const sources = data.bySource;
  const shown = src === "(all)" ? data.leads : data.leads.filter((l) => (l.source && /\b(x|twitter)\b/i.test(l.source) ? "X / Twitter" : (l.source || "(unknown)").replace(/\s+/g, " ")) === src);
  const matchedShown = shown.filter((l) => l.match).length;
  return (
    <Section title="Leads" blurb={blurb}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
        {[{ label: "All", key: "(all)", value: data.total }, ...sources.map((s) => ({ label: s.label, key: s.label, value: s.value }))].map((s) => (
          <button key={s.key} onClick={() => setSrc(s.key)} style={{
            padding: "4px 12px", fontSize: 12, fontWeight: 700, borderRadius: 999, cursor: "pointer",
            border: src === s.key ? "1.5px solid var(--navy,#254254)" : "1.5px solid #e3ddcf",
            background: src === s.key ? "var(--navy,#254254)" : "#fff", color: src === s.key ? "#fff" : "var(--navy,#254254)",
          }}>{s.label} <span style={{ opacity: 0.7 }}>{s.value}</span></button>
        ))}
        <span className="muted" style={{ fontSize: 11, marginLeft: "auto" }}>{shown.length} lead{shown.length === 1 ? "" : "s"} · {matchedShown} matched to revenue</span>
      </div>
      {shown.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No leads in this window for this source.</p> : (
        <div className="table-scroll"><table className="dash">
          <thead><tr><th>date</th><th>name</th><th>email</th><th>domains</th><th>source</th><th>budget</th><th>revenue match</th></tr></thead>
          <tbody>
            {shown.map((l, i) => (
              <tr key={i}>
                <td className="muted" style={{ whiteSpace: "nowrap" }}>{l.date}</td>
                <td>{l.name || "—"}</td>
                <td className="muted">{l.email ? <a href={`mailto:${l.email}`}>{l.email}</a> : "—"}</td>
                <td>{l.domains.length ? l.domains.join(", ") : <span className="muted">—</span>}</td>
                <td className="muted">{l.source || "—"}</td>
                <td className="muted">{l.budget || "—"}</td>
                <td>{l.match ? (
                  <span title={`matched by ${l.match.via}`}>💰 {l.match.dealName}{l.match.status ? ` · ${l.match.status.toLowerCase()}` : ""}{l.match.clientPaid ? ` · ${usd(l.match.clientPaid)}` : l.match.acquisitionPrice ? ` · ${usd(l.match.acquisitionPrice)} acq` : ""}</span>
                ) : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </Section>
  );
}

// Per-campaign + per-ad effectiveness, lazy-loaded (own request) like the lift view.
function EffectivenessLoader({ range }: { range: { from: string; to: string } }) {
  const [data, setData] = useState<XAdsEffectiveness | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [msg, setMsg] = useState("");
  const [level, setLevel] = useState<"campaign" | "ad">("campaign");
  useEffect(() => {
    let live = true;
    setState("loading"); setMsg("");
    (async () => {
      try {
        const res = await fetch(`/api/admin/analytics?tranche=ads&part=effectiveness&from=${range.from}&to=${range.to}`, { cache: "no-store" });
        const json = JSON.parse(await res.text());
        if (!live) return;
        if (!res.ok || json.ok === false) throw new Error(json.error || `Failed (${res.status})`);
        setData(json.effectiveness || null); setState("done");
      } catch (e) {
        if (live) { setState("error"); setMsg(String((e as Error).message || e)); }
      }
    })();
    return () => { live = false; };
  }, [range.from, range.to]);

  const blurb = "Engagement efficiency, runtime and week-over-week CTR trend, per campaign and per ad. Δ CTR compares the last active week to the first (negative = the creative is fatiguing). Conversion efficiency stays account-level (see Ad lift) until the X pixel reports per-ad conversions.";
  if (state === "loading") return <Section title="Effectiveness" blurb={blurb}><p className="muted" style={{ fontSize: 13 }}>Loading effectiveness…</p></Section>;
  if (state === "error") return <Section title="Effectiveness" blurb={blurb}><p className="muted" style={{ fontSize: 13 }}>Couldn&apos;t load effectiveness ({msg}). The per-ad cache may not be backfilled yet.</p></Section>;
  if (!data) return null;
  const rows = level === "campaign" ? data.campaigns : data.ads;
  return (
    <Section title="Effectiveness" blurb={blurb}>
      <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3, marginBottom: 12 }}>
        {(["campaign", "ad"] as const).map((l) => (
          <button key={l} onClick={() => setLevel(l)} style={{
            padding: "4px 14px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer", textTransform: "capitalize",
            background: level === l ? "var(--navy, #254254)" : "transparent", color: level === l ? "#fff" : "var(--navy, #254254)",
          }}>{l === "ad" ? "Per ad" : "Per campaign"}</button>
        ))}
        <span className="muted" style={{ alignSelf: "center", fontSize: 11, padding: "0 6px" }}>{rows.length} {level === "ad" ? "ads" : "campaigns"} with activity</span>
      </div>
      {level === "ad" && data.coverage.campaignSpend > 0 && data.coverage.adSpend < data.coverage.campaignSpend * 0.98 && (
        <p className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
          Per-ad covers {usd(data.coverage.adSpend)} of {usd(data.coverage.campaignSpend)} spend ({Math.round((data.coverage.adSpend / data.coverage.campaignSpend) * 100)}%). The rest is on auto-promotion (&quot;all top performers&quot;) campaigns, which X reports only at the campaign level — see the Per-campaign view for those.
        </p>
      )}
      <EffTable rows={rows} kind={level} />
    </Section>
  );
}

// The lift model recomputes a 90-day trailing window (~40 throttled X API calls),
// so it's fetched in its OWN request, lazily, AFTER the spend view has painted —
// keeping the main Ads load fast and never letting the heavy computation (or its
// occasional timeout) take down the whole tab.
function LiftLoader({ to }: { to: string }) {
  const [lift, setLift] = useState<XAdsLift | null>(null);
  const [state, setState] = useState<"loading" | "done" | "error">("loading");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    let live = true;
    setState("loading"); setMsg("");
    (async () => {
      try {
        const res = await fetch(`/api/admin/analytics?tranche=ads&part=lift&to=${to}`, { cache: "no-store" });
        const text = await res.text();
        const data = JSON.parse(text); // guarded: a platform timeout returns non-JSON
        if (!live) return;
        if (!res.ok || data.ok === false) throw new Error(data.error || `Failed (${res.status})`);
        setLift(data.lift || null); setState("done");
      } catch (e) {
        if (live) { setState("error"); setMsg(String((e as Error).message || e)); }
      }
    })();
    return () => { live = false; };
  }, [to]);
  if (state === "loading") return <Section title="Ad lift (incrementality)" blurb="Crunching the trailing-90-day baseline…"><p className="muted" style={{ fontSize: 13 }}>Loading lift analysis…</p></Section>;
  if (state === "error") return <Section title="Ad lift (incrementality)" blurb="Traffic lift on ad-running days vs dark days."><p className="muted" style={{ fontSize: 13 }}>Couldn&apos;t load the lift analysis ({msg}). The spend numbers above are unaffected — retry from Refresh.</p></Section>;
  if (!lift) return null;
  return <LiftSection lift={lift} />;
}

// Ad Lift (incrementality) — most X spend boosts organic posts (no click-through),
// so we measure the traffic lift on ad-running days vs dark days, per channel and
// day-of-week-matched. The channel set crediting the lift is toggleable (defaults to
// the social channels; Direct/type-in is dominated by the marketplace and only adds
// noise) — flip channels and the headline $/incremental-visit recomputes live.
function LiftSection({ lift }: { lift: XAdsLift }) {
  const [sel, setSel] = useState<Set<string>>(() => new Set(lift.defaultChannels));
  const toggle = (c: string) => setSel((prev) => {
    const next = new Set(prev);
    if (next.has(c)) next.delete(c); else next.add(c);
    return next;
  });
  const incremental = lift.channels.filter((c) => sel.has(c.channel)).reduce((a, c) => a + c.incrementalVisits, 0);
  const costPerVisit = incremental > 0 ? lift.spend / incremental : null;
  return (
    <Section title="Ad lift (incrementality)" blurb={`Most X spend boosts organic posts (no click-through links), so instead of click attribution this compares traffic on ad-running days vs dark days, day-of-week-matched, over a trailing ${lift.lookbackDays} days (${lift.from} → ${lift.to}: ${lift.adDays} ad days vs ${lift.offDays} dark days). Tick the channels to credit — the social channels are the clean signal; Direct/type-in is dominated by the marketplace business.`}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <StatCard label="Incremental visits" sub="from selected channels" text={incremental > 0 ? fmt(Math.round(incremental)) : "—"} accent />
        <StatCard label="Cost per incremental visit" sub="X spend ÷ incremental" text={costPerVisit != null ? `$${costPerVisit.toFixed(2)}` : "—"} accent />
        <StatCard label="Spend (lift window)" text={usd(lift.spend)} />
        <StatCard label="Ad days / dark days" text={`${lift.adDays} / ${lift.offDays}`} />
      </div>
      <div className="table-scroll"><table className="dash">
        <thead><tr><th>credit</th><th>channel</th><th className="right">baseline/day</th><th className="right">ad day/day</th><th className="right">incremental</th><th className="right">$/incr. visit</th></tr></thead>
        <tbody>
          {lift.channels.map((c) => {
            const on = sel.has(c.channel);
            const cpv = c.incrementalVisits > 0 ? lift.spend / c.incrementalVisits : null;
            return (
              <tr key={c.channel} style={{ opacity: on ? 1 : 0.5 }}>
                <td><input type="checkbox" checked={on} onChange={() => toggle(c.channel)} aria-label={`Credit ${c.channel}`} /></td>
                <td>{c.channel}</td>
                <td className="right muted">{c.baselinePerDay.toFixed(1)}</td>
                <td className="right muted">{c.adPerDay.toFixed(1)}</td>
                <td className="right" style={{ color: c.incrementalVisits >= 0 ? "inherit" : CORAL }}>{c.incrementalVisits >= 0 ? "+" : ""}{fmt(Math.round(c.incrementalVisits))}</td>
                <td className="right muted">{cpv != null ? `$${cpv.toFixed(2)}` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <p className="muted" style={{ fontSize: 11, marginTop: 8 }}>
        Correlational, not a holdout experiment — anything that moves with ad timing is folded in, and a negative figure means that channel ran lower on ad days (noise, or other factors). Treat it as a directional read on the brand-awareness halo, cross-checked against self-reported &quot;X / Twitter&quot; leads above.
      </p>
    </Section>
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
