"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReportsSubnav from "../reports-subnav";
import { BarList, TrendChart, FunnelChart, type Bar } from "./analytics-charts";

// ── Types mirror lib/ga.ts + lib/revenue.ts ─────────────────────────────────
type Tranche = "core" | "marketplace" | "blog" | "revenue";
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

type Preset = "today" | "week" | "month" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "custom", label: "Custom range" },
];
const TRANCHES: { key: Tranche; label: string }[] = [
  { key: "core", label: "Core Services" }, { key: "marketplace", label: "Marketplace" }, { key: "blog", label: "Blog / SEO" }, { key: "revenue", label: "Revenue" },
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

export default function AnalyticsClient({ canCost }: { canCost: boolean }) {
  const [tranche, setTranche] = useState<Tranche>("core");
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
      const res = await fetch(`/api/admin/analytics?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.configured === false) { setConfigured(false); setLoaded(null); setMsg(data.error || "Not configured."); return; }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setConfigured(true); setLoaded({ tranche: data.tranche, report: data.report });
    } catch (e) { setMsg(String((e as Error).message || e)); } finally { setLoading(false); }
  }, [tranche, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <main>
      <ReportsSubnav canCost={canCost} canAnalytics />
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

      {msg && <p style={{ fontSize: 13, color: CORAL }}>{msg}</p>}

      {!configured ? (
        <p className="muted">Not configured for this deployment. Set <code>GA4_PROPERTY_ID</code> and <code>GOOGLE_SA_KEY</code> in the project env, then refresh.</p>
      ) : !loaded && loading ? (
        <p className="muted">Loading…</p>
      ) : loaded ? (
        loaded.tranche === "marketplace" ? <MarketplaceView r={loaded.report as MarketplaceReport} />
          : loaded.tranche === "blog" ? <BlogView r={loaded.report as BlogReport} />
            : loaded.tranche === "revenue" ? <RevenueView r={loaded.report as RevenueReport} />
              : <CoreView r={loaded.report as CoreReport} />
      ) : (
        <p className="muted">No data for this window.</p>
      )}

      {loaded && loaded.tranche !== "revenue" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>
          Source: GA4 Data API (timezone America/New_York). Submissions blend the historical Formspark export (through
          2026-06-07) with GA conversion events (forward). Self-reported source / intent / budget come from form fields —
          historical from the export, live from GA event params once the matching custom dimensions are registered.
        </p>
      )}
      {loaded && loaded.tranche === "revenue" && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>Source: Snagged Domain Tracker (Payments tab), aggregated by Client Paid Date over the window.</p>
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
