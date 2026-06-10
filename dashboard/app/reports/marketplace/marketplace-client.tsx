"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/ga.ts ListingRow / MarketplaceReport.
type ListingRow = { domain: string; path: string; views: number; sessions: number; users: number; inquiryStarts: number; clicks: number; inquiries: number };
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type MarketplaceReport = { summary: StatBlock; listings: ListingRow[] };
type SortKey = "views" | "users" | "sessions" | "inquiryStarts" | "clicks" | "inquiries";

const CORAL = "var(--coral-deep, #c0492f)";
const fmt = (x: number) => x.toLocaleString();
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const pad2 = (x: number) => String(x).padStart(2, "0");

const TODAY = etYmd(new Date());
const YESTERDAY = etYmd(new Date(Date.now() - 86400000));
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000));
const MONTH_START = `${TODAY.slice(0, 7)}-01`;
const LAST_WEEK_START = etYmd(new Date(Date.now() - 13 * 86400000));
const LAST_WEEK_END = etYmd(new Date(Date.now() - 7 * 86400000));
const _ty = Number(TODAY.slice(0, 4)), _tm = Number(TODAY.slice(5, 7));
const _lmEnd = new Date(Date.UTC(_ty, _tm - 1, 0)); // day 0 of this month = last day of prev month
const LAST_MONTH_END = `${_lmEnd.getUTCFullYear()}-${pad2(_lmEnd.getUTCMonth() + 1)}-${pad2(_lmEnd.getUTCDate())}`;
const LAST_MONTH_START = `${_lmEnd.getUTCFullYear()}-${pad2(_lmEnd.getUTCMonth() + 1)}-01`;

type Preset = "today" | "yesterday" | "week" | "lastweek" | "month" | "lastmonth" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" }, { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" }, { key: "lastweek", label: "Last week" },
  { key: "month", label: "This month" }, { key: "lastmonth", label: "Last month" },
  { key: "custom", label: "Custom range" },
];

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? CORAL : "var(--navy, #254254)" }}>{fmt(value)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
    </div>
  );
}

export default function MarketplaceClient() {
  const [preset, setPreset] = useState<Preset>("week");
  const [from, setFrom] = useState(WEEK_START);
  const [to, setTo] = useState(TODAY);
  const [report, setReport] = useState<MarketplaceReport | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [sort, setSort] = useState<SortKey>("views");

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
      const q = new URLSearchParams({ from: range.from, to: range.to });
      const res = await fetch(`/api/admin/marketplace?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setConfigured(data.configured !== false);
      setReport((data.report as MarketplaceReport) || null);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const listings = useMemo(() => {
    const rows = report?.listings ? [...report.listings] : [];
    rows.sort((a, b) => b[sort] - a[sort] || b.views - a.views);
    return rows;
  }, [report, sort]);

  const s = report?.summary;
  const rangeLabel = range.from === range.to ? range.from : `${range.from} → ${range.to}`;
  const cell = { padding: "6px 10px", borderBottom: "1px solid var(--line, #eee)", whiteSpace: "nowrap" as const };
  const num = { ...cell, textAlign: "right" as const, fontVariantNumeric: "tabular-nums" as const };
  const th = (k: SortKey, label: string) => (
    <th onClick={() => setSort(k)} style={{ ...num, color: sort === k ? CORAL : "var(--muted, #888)", fontWeight: 600, cursor: "pointer", userSelect: "none" }}>
      {label}{sort === k ? " ↓" : ""}
    </th>
  );

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Marketplace</h1>
      <p className="section-blurb" style={{ marginTop: 0 }}>
        Every domain on <strong>snagged.com/marketplace</strong> with its GA4 traffic for the selected window.
        <strong> Inquiry starts</strong> = the inquiry form was opened on that listing; <strong>Inquiries</strong> = completed
        submissions (fills in per-domain once the GA <code>domain_of_interest</code> dimension is live).
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "10px 0 4px" }}>
        <span className="muted" style={{ fontSize: 13 }}>Window</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} className="field" style={{ padding: "5px 8px", fontSize: 13 }}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {preset === "custom" && (
          <>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)} className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)} className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
          </>
        )}
        <button onClick={() => void load()} className="field" style={{ padding: "5px 12px", fontSize: 13, cursor: "pointer" }} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        <span className="muted" style={{ fontSize: 12 }}>{rangeLabel}</span>
      </div>

      {msg && <p style={{ color: CORAL }}>{msg}</p>}
      {!configured && <p className="muted">GA4 isn&apos;t configured on this deployment (GA4_PROPERTY_ID / GOOGLE_SA_KEY).</p>}

      {s && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          <StatCard label="Listings" value={listings.length} />
          <StatCard label="Visits (pageviews)" value={s.pageviews} />
          <StatCard label="Visitors" value={s.users} />
          <StatCard label="Inquiries (form)" value={s.submissions} accent />
        </div>
      )}

      <div style={{ overflowX: "auto", marginTop: 18 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: "left", color: "var(--muted, #888)", fontWeight: 600 }}>Domain</th>
              {th("views", "Visits")}{th("users", "Visitors")}{th("sessions", "Sessions")}
              {th("inquiryStarts", "Inquiry starts")}{th("clicks", "CTA clicks")}{th("inquiries", "Inquiries")}
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.path}>
                <td style={{ ...cell, textAlign: "left" }}>
                  <a href={`https://www.snagged.com${l.path}`} target="_blank" rel="noreferrer" style={{ color: CORAL, textDecoration: "none" }}>{l.domain}</a>
                </td>
                <td style={num}>{fmt(l.views)}</td><td style={num}>{fmt(l.users)}</td><td style={num}>{fmt(l.sessions)}</td>
                <td style={num}>{fmt(l.inquiryStarts)}</td><td style={num}>{fmt(l.clicks)}</td>
                <td style={{ ...num, color: l.inquiries > 0 ? CORAL : "inherit", fontWeight: l.inquiries > 0 ? 600 : 400 }}>{fmt(l.inquiries)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && listings.length === 0 && <p className="muted" style={{ padding: 8 }}>No marketplace listings with data in this window.</p>}
      </div>
    </main>
  );
}
