"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/ga.ts ListingRow / MarketplaceReport.
type NewsletterSummary = { count: number; forSale: number; content: number; lastDate: string | null; dates: string[] };
type ListingRow = { domain: string; path: string; views: number; sessions: number; users: number; inquiryStarts: number; clicks: number; inquiries: number; newsletter?: NewsletterSummary };
type StatBlock = { sessions: number; users: number; pageviews: number; submissions: number };
type MarketplaceReport = { summary: StatBlock; listings: ListingRow[] };
type SortKey = "views" | "users" | "sessions" | "inquiryStarts" | "inquiries";

const CORAL = "var(--coral-deep, #c0492f)";
// Compact controls — consistent with the drill-down (the `.field` class is full-width).
const CTL: React.CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", maxWidth: 200, cursor: "pointer" };
const BTN: React.CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer", whiteSpace: "nowrap" };
const fmt = (x: number) => x.toLocaleString();
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());

// Consistent with the per-domain drill-down report.
type Preset = "30" | "90" | "365" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "30", label: "Last 30 days" }, { key: "90", label: "Last 90 days" },
  { key: "365", label: "Last 12 months" }, { key: "all", label: "All time" }, { key: "custom", label: "Custom" },
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
  const [preset, setPreset] = useState<Preset>("90");
  const [from, setFrom] = useState(etYmd(new Date(Date.now() - 89 * 86400000)));
  const [to, setTo] = useState(TODAY);
  const [report, setReport] = useState<MarketplaceReport | null>(null);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [sort, setSort] = useState<SortKey>("views");

  const range = useMemo(() => {
    if (preset === "30") return { from: etYmd(new Date(Date.now() - 29 * 86400000)), to: TODAY };
    if (preset === "90") return { from: etYmd(new Date(Date.now() - 89 * 86400000)), to: TODAY };
    if (preset === "365") return { from: etYmd(new Date(Date.now() - 364 * 86400000)), to: TODAY };
    if (preset === "all") return { from: "2024-01-01", to: TODAY };
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

  const sortVal = (l: ListingRow, k: SortKey) => l[k] as number;
  const listings = useMemo(() => {
    const rows = report?.listings ? [...report.listings] : [];
    rows.sort((a, b) => sortVal(b, sort) - sortVal(a, sort) || b.views - a.views);
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
        Click a domain for its full <strong>activity report</strong> — inbound inquiries, pitches, negotiations, sale status &amp; newsletter exposure.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
        <span className="muted" style={{ fontSize: 12 }}>Window:</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={CTL}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {preset === "custom" && (
          <>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)} style={CTL} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)} style={CTL} />
          </>
        )}
        <button onClick={() => void load()} style={BTN} disabled={loading}>↻ Refresh</button>
        {loading
          ? <span className="loading-pulse" style={{ fontSize: 12, color: CORAL }}>working…</span>
          : <span className="muted" style={{ fontSize: 12 }}>{rangeLabel}</span>}
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
        <table style={{ width: "auto", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...cell, textAlign: "left", color: "var(--muted, #888)", fontWeight: 600 }}>Domain</th>
              {th("views", "Visits")}{th("users", "Visitors")}{th("sessions", "Sessions")}
              {th("inquiryStarts", "Inquiry starts")}{th("inquiries", "Inquiries")}
              <th style={{ ...cell, color: "var(--muted, #888)", fontWeight: 600 }}></th>
            </tr>
          </thead>
          <tbody>
            {listings.map((l) => (
              <tr key={l.path}>
                <td style={{ ...cell, textAlign: "left" }}>
                  <a href={`/reports/marketplace/${encodeURIComponent(l.domain.toLowerCase())}`} style={{ color: CORAL, textDecoration: "none", fontWeight: 600 }}>{l.domain}</a>
                  {l.path && <a href={`https://www.snagged.com${l.path}`} target="_blank" rel="noreferrer" title="Open listing" style={{ color: "var(--muted,#888)", textDecoration: "none", marginLeft: 6, fontSize: 12 }}>↗</a>}
                </td>
                <td style={num}>{fmt(l.views)}</td><td style={num}>{fmt(l.users)}</td><td style={num}>{fmt(l.sessions)}</td>
                <td style={num}>{fmt(l.inquiryStarts)}</td>
                <td style={{ ...num, color: l.inquiries > 0 ? CORAL : "inherit", fontWeight: l.inquiries > 0 ? 600 : 400 }}>{fmt(l.inquiries)}</td>
                <td style={{ ...cell, textAlign: "left" }}>
                  <a href={`/reports/marketplace/${encodeURIComponent(l.domain.toLowerCase())}`} style={{ color: CORAL, textDecoration: "none", fontSize: 12 }}>Activity →</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && listings.length === 0 && <p className="muted" style={{ padding: 8 }}>No marketplace listings with data in this window.</p>}
      </div>
    </main>
  );
}
