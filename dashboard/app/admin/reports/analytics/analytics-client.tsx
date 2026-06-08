"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReportsSubnav from "../reports-subnav";
import { BarList, TrendChart, type Bar } from "./analytics-charts";

// ── Types mirror lib/ga.ts ───────────────────────────────────────────────────
type Tranche = "marketplace" | "core";
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type ChannelRow = { channel: string; sessions: number; users: number };
type PageRow = { path: string; views: number; users: number };
type SourceRow = { source: string; medium: string; sessions: number };
type LabelValue = { label: string; value: number };
type TrendRow = { date: string; sessions: number; pageviews: number };
type MarketplaceReport = { tranche: "marketplace"; summary: StatBlock; topPages: PageRow[]; channels: ChannelRow[]; trend: TrendRow[] };
type CoreReport = {
  tranche: "core"; summary: StatBlock; channels: ChannelRow[]; sources: SourceRow[];
  submissionsByChannel: LabelValue[]; selfReportedSource: LabelValue[]; leadIntent: LabelValue[]; leadBudget: LabelValue[]; trend: TrendRow[];
};
type Report = MarketplaceReport | CoreReport;

type Preset = "today" | "week" | "month" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" }, { key: "custom", label: "Custom range" },
];
const TRANCHES: { key: Tranche; label: string }[] = [
  { key: "core", label: "Core Services" }, { key: "marketplace", label: "Marketplace" },
];
// Budget bands (the form's select values) that count as a "quality" lead.
const QUALITY_BUDGETS = ["$25K to $100K", "$100K+"];

const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000));
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const fmt = (x: number) => x.toLocaleString();
const CORAL = "var(--coral-deep, #c0492f)";

function StatCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? CORAL : "var(--navy, #254254)" }}>{fmt(value)}</div>
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
  const [tranche, setTranche] = useState<Tranche>("core"); // Core Services is the default view
  const [preset, setPreset] = useState<Preset>("week");
  const [from, setFrom] = useState(WEEK_START);
  const [to, setTo] = useState(TODAY);
  const [report, setReport] = useState<Report | null>(null);
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
      if (data.configured === false) { setConfigured(false); setReport(null); setMsg(data.error || "GA not configured."); return; }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setConfigured(true); setReport(data.report as Report);
    } catch (e) { setMsg(String((e as Error).message || e)); } finally { setLoading(false); }
  }, [tranche, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;

  return (
    <main>
      <ReportsSubnav canCost={canCost} canAnalytics />
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Site analytics</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        snagged.com traffic from Google Analytics, split into the two businesses that share the domain: the{" "}
        <strong>Core Services</strong> site (the sell-side — people who want to engage Snagged) and the{" "}
        <strong>Marketplace</strong> (the <code>/domains/*</code> type-in domain buyers). Form submissions are the GA conversion events the site fires on submit.
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3 }}>
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
        <p className="muted">Google Analytics isn&apos;t configured for this deployment. Set <code>GA4_PROPERTY_ID</code> and <code>GOOGLE_SA_KEY</code> in the project env, then refresh.</p>
      ) : !report && loading ? (
        <p className="muted">Loading…</p>
      ) : report ? (
        report.tranche === "marketplace" ? <MarketplaceView report={report} /> : <CoreView report={report} />
      ) : (
        <p className="muted">No data for this window.</p>
      )}

      {report && (
        <p className="muted" style={{ fontSize: 12, marginTop: 22 }}>
          Source: Google Analytics 4 (GA4 Data API), property timezone America/New_York. Submission counts reflect the GA
          conversion events fired on submit. Self-reported source / intent / budget come from form fields passed as GA event
          params — they populate once the matching custom dimensions are registered in GA4 (~24–48h lag).
        </p>
      )}
    </main>
  );
}

function MarketplaceView({ report }: { report: MarketplaceReport }) {
  const s = report.summary;
  const pageBars: Bar[] = report.topPages.slice(0, 15).map((p) => ({
    label: p.path.replace(/^\/domains\//, ""), value: p.views, href: `https://www.snagged.com${p.path}`,
  }));
  const channelBars: Bar[] = report.channels.map((c) => ({ label: c.channel, value: c.sessions }));
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Sessions" value={s.sessions} />
        <StatCard label="Users" value={s.users} />
        <StatCard label="Pageviews" value={s.pageviews} />
        <StatCard label="Inquiries (form)" value={s.submissions} accent />
      </div>
      <Section title="Top pages by views" blurb="Which domain listings are getting looked at most.">
        <BarList rows={pageBars} />
      </Section>
      <Section title="Traffic by channel" blurb="How marketplace visitors arrive (mostly Direct — type-ins).">
        <BarList rows={channelBars} showShare />
      </Section>
      <Section title="Daily trend"><TrendChart data={report.trend} /></Section>
    </>
  );
}

function CoreView({ report }: { report: CoreReport }) {
  const s = report.summary;
  const quality = report.leadBudget.filter((b) => QUALITY_BUDGETS.includes(b.label)).reduce((a, b) => a + b.value, 0);
  const channelBars: Bar[] = report.channels.map((c) => ({ label: c.channel, value: c.sessions }));
  const sourceBars: Bar[] = report.sources.slice(0, 12).map((r) => ({ label: r.source === "(direct)" ? "direct" : `${r.source} / ${r.medium}`, value: r.sessions }));
  const submitBars: Bar[] = report.submissionsByChannel.map((r) => ({ label: r.label, value: r.value }));
  const sourceSelf: Bar[] = report.selfReportedSource.map((r) => ({ label: r.label, value: r.value }));
  const intentBars: Bar[] = report.leadIntent.map((r) => ({ label: r.label, value: r.value }));
  const budgetBars: Bar[] = report.leadBudget.map((r) => ({ label: r.label, value: r.value }));
  const pendingNote = "Populates once the matching GA4 custom dimension is registered and submissions come in.";
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Sessions" value={s.sessions} />
        <StatCard label="Users" value={s.users} />
        <StatCard label="Leads (form)" value={s.submissions} accent />
        <StatCard label="Quality leads" sub="budget ≥ $25K" value={quality} accent />
      </div>
      <Section title="Where traffic comes from" blurb="The sell-side is multi-channel — this is where source detail matters.">
        <BarList rows={channelBars} showShare />
      </Section>
      <Section title="Top sources" blurb="Source / medium behind the channels above.">
        <BarList rows={sourceBars} />
      </Section>
      <Section title="Form submissions by channel" blurb="Which channels actually produce leads (GA generate_lead).">
        <BarList rows={submitBars} color={CORAL} empty="No GA-tracked submissions yet in this window." />
      </Section>
      <Section title="Self-reported source" blurb='"How did you hear about Snagged?" — captured on the form, the truest attribution we have.'>
        <BarList rows={sourceSelf} color={CORAL} empty={pendingNote} />
      </Section>
      <Section title="Lead intent" blurb="Acquire vs sell, off the form's intent select.">
        <BarList rows={intentBars} empty={pendingNote} />
      </Section>
      <Section title="Lead budget" blurb="Budget mix of submissions — quality leads are the top two bands.">
        <BarList rows={budgetBars} empty={pendingNote} />
      </Section>
      <Section title="Daily trend"><TrendChart data={report.trend} /></Section>
    </>
  );
}
