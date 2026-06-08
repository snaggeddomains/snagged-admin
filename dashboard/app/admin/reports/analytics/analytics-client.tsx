"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ReportsSubnav from "../reports-subnav";

// ── Types mirror lib/ga.ts ───────────────────────────────────────────────────
type Tranche = "marketplace" | "core";
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type ChannelRow = { channel: string; sessions: number; users: number };
type PageRow = { path: string; views: number; users: number };
type SourceRow = { source: string; medium: string; sessions: number };
type LabelValue = { label: string; value: number };
type TrendRow = { date: string; sessions: number; pageviews: number };
type MarketplaceReport = { tranche: "marketplace"; summary: StatBlock; topPages: PageRow[]; channels: ChannelRow[]; trend: TrendRow[] };
type CoreReport = { tranche: "core"; summary: StatBlock; channels: ChannelRow[]; sources: SourceRow[]; submissionsByChannel: LabelValue[]; trend: TrendRow[] };
type Report = MarketplaceReport | CoreReport;

type Preset = "today" | "week" | "month" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom range" },
];
const TRANCHES: { key: Tranche; label: string }[] = [
  { key: "marketplace", label: "Marketplace" },
  { key: "core", label: "Core / Services" },
];

// ET calendar-day helpers (the GA property runs on America/New_York, so presets
// align with what GA reports).
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000));
const MONTH_START = `${TODAY.slice(0, 7)}-01`;

const num = (x: number) => x.toLocaleString();
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? "var(--coral-deep, #c0492f)" : "var(--navy, #254254)" }}>{num(value)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function AnalyticsClient({ canCost }: { canCost: boolean }) {
  const [tranche, setTranche] = useState<Tranche>("marketplace");
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
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ tranche, from: range.from, to: range.to });
      const res = await fetch(`/api/admin/analytics?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (data.configured === false) {
        setConfigured(false);
        setReport(null);
        setMsg(data.error || "GA not configured.");
        return;
      }
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setConfigured(true);
      setReport(data.report as Report);
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [tranche, range.from, range.to]);

  useEffect(() => { load(); }, [load]);

  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;
  const s = report?.summary;
  // Submissions card is the GA conversion event our Webflow snippet fires.
  const submitLabel = tranche === "marketplace" ? "Inquiries (form)" : "Leads (form)";

  return (
    <main>
      <ReportsSubnav canCost={canCost} canAnalytics />

      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Site analytics</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        snagged.com traffic from Google Analytics, split into the two businesses
        that share the domain: the <strong>Marketplace</strong> (the <code>/domains/*</code>{" "}
        type-in domain buyers) and the <strong>Core / Services</strong> site (the
        sell-side — people who want to engage Snagged). Form submissions are the
        GA conversion events the site fires on submit.
      </p>

      {/* Controls: tranche toggle + window + custom range. */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3 }}>
          {TRANCHES.map((t) => (
            <button
              key={t.key}
              onClick={() => setTranche(t.key)}
              style={{
                padding: "5px 14px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer",
                background: tranche === t.key ? "var(--navy, #254254)" : "transparent",
                color: tranche === t.key ? "#fff" : "var(--navy, #254254)",
              }}
            >
              {t.label}
            </button>
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

      {msg && <p style={{ fontSize: 13, color: "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      {!configured ? (
        <p className="muted">
          Google Analytics isn&apos;t configured for this deployment yet. Set{" "}
          <code>GA4_PROPERTY_ID</code> and <code>GOOGLE_SA_KEY</code> in the
          snagged-admin project env, then refresh.
        </p>
      ) : !report && loading ? (
        <p className="muted">Loading…</p>
      ) : report ? (
        <>
          {/* Summary cards */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
            <StatCard label="Sessions" value={s?.sessions ?? 0} />
            <StatCard label="Users" value={s?.users ?? 0} />
            <StatCard label="Pageviews" value={s?.pageviews ?? 0} />
            <StatCard label={submitLabel} value={s?.submissions ?? 0} accent />
          </div>

          {report.tranche === "marketplace" ? (
            <MarketplaceView report={report} />
          ) : (
            <CoreView report={report} />
          )}

          <p className="muted" style={{ fontSize: 12, marginTop: 18 }}>
            Source: Google Analytics 4 (GA4 Data API), property timezone America/New_York.
            Form-submission counts reflect the GA conversion events fired on submit;
            the authoritative lead records (with budget, intent, and self-reported
            source) live in Formspark — to be joined into this report next.
          </p>
        </>
      ) : (
        <p className="muted">No data for this window.</p>
      )}
    </main>
  );
}

function Section({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontSize: 18 }}>{title}</h2>
      {blurb && <p className="section-blurb" style={{ marginTop: 0 }}>{blurb}</p>}
      {children}
    </section>
  );
}

function MarketplaceView({ report }: { report: MarketplaceReport }) {
  const totalSessions = report.channels.reduce((a, c) => a + c.sessions, 0);
  return (
    <>
      <Section title="Top pages by views" blurb="Which domain listings are getting looked at most.">
        <div className="table-scroll"><table className="dash">
          <thead><tr><th>page</th><th className="right">views</th><th className="right">users</th></tr></thead>
          <tbody>
            {report.topPages.map((p) => (
              <tr key={p.path}>
                <td className="mono"><a href={`https://www.snagged.com${p.path}`} target="_blank" rel="noreferrer">{p.path}</a></td>
                <td className="right">{num(p.views)}</td>
                <td className="right muted">{num(p.users)}</td>
              </tr>
            ))}
            {report.topPages.length === 0 && <tr><td colSpan={3} className="muted">No page views in this window.</td></tr>}
          </tbody>
        </table></div>
      </Section>

      <Section title="Traffic by channel" blurb="How marketplace visitors arrive (mostly Direct — type-ins).">
        <ChannelTable rows={report.channels} total={totalSessions} />
      </Section>

      <TrendSection trend={report.trend} />
    </>
  );
}

function CoreView({ report }: { report: CoreReport }) {
  const totalSessions = report.channels.reduce((a, c) => a + c.sessions, 0);
  const totalSubs = report.submissionsByChannel.reduce((a, c) => a + c.value, 0);
  return (
    <>
      <Section title="Where traffic comes from" blurb="The sell-side is multi-channel — this is where the source detail matters.">
        <ChannelTable rows={report.channels} total={totalSessions} />
      </Section>

      <Section title="Top sources" blurb="Source / medium pairs behind the channels above.">
        <div className="table-scroll"><table className="dash">
          <thead><tr><th>source</th><th>medium</th><th className="right">sessions</th></tr></thead>
          <tbody>
            {report.sources.map((r) => (
              <tr key={`${r.source}/${r.medium}`}>
                <td className="mono">{r.source}</td>
                <td className="muted">{r.medium}</td>
                <td className="right">{num(r.sessions)}</td>
              </tr>
            ))}
            {report.sources.length === 0 && <tr><td colSpan={3} className="muted">No sessions in this window.</td></tr>}
          </tbody>
        </table></div>
      </Section>

      <Section title="Form submissions by channel" blurb="Which channels actually produce leads (GA generate_lead events).">
        <div className="table-scroll"><table className="dash">
          <thead><tr><th>channel</th><th className="right">submissions</th><th className="right">share</th></tr></thead>
          <tbody>
            {report.submissionsByChannel.map((r) => (
              <tr key={r.label}>
                <td className="mono">{r.label}</td>
                <td className="right">{num(r.value)}</td>
                <td className="right muted">{pct(r.value, totalSubs)}</td>
              </tr>
            ))}
            {report.submissionsByChannel.length === 0 && <tr><td colSpan={3} className="muted">No GA-tracked submissions yet in this window.</td></tr>}
          </tbody>
        </table></div>
      </Section>

      <Section title="Self-reported source" blurb='"How did you hear about Snagged?" — captured on the form itself.'>
        <p className="muted" style={{ fontSize: 13 }}>
          Coming next: this populates from the Formspark submissions once the
          submissions Sheet is connected. From the latest export, X / Twitter is
          by far the top self-reported source for services leads.
        </p>
      </Section>

      <TrendSection trend={report.trend} />
    </>
  );
}

function ChannelTable({ rows, total }: { rows: ChannelRow[]; total: number }) {
  return (
    <div className="table-scroll"><table className="dash">
      <thead><tr><th>channel</th><th className="right">sessions</th><th className="right">users</th><th className="right">share</th></tr></thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.channel}>
            <td className="mono">{c.channel}</td>
            <td className="right">{num(c.sessions)}</td>
            <td className="right muted">{num(c.users)}</td>
            <td className="right muted">{pct(c.sessions, total)}</td>
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={4} className="muted">No sessions in this window.</td></tr>}
      </tbody>
    </table></div>
  );
}

function TrendSection({ trend }: { trend: TrendRow[] }) {
  return (
    <Section title="Daily trend">
      <div className="table-scroll"><table className="dash">
        <thead><tr><th>day</th><th className="right">sessions</th><th className="right">pageviews</th></tr></thead>
        <tbody>
          {trend.map((t) => (
            <tr key={t.date}><td className="mono">{t.date}</td><td className="right">{num(t.sessions)}</td><td className="right muted">{num(t.pageviews)}</td></tr>
          ))}
          {trend.length === 0 && <tr><td colSpan={3} className="muted">No data in this window.</td></tr>}
        </tbody>
      </table></div>
    </Section>
  );
}
