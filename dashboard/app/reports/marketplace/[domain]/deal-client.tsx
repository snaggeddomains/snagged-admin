"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/marketplace-deals.ts + lib/ga.ts ListingRow + newsletter summary.
type SaleStatus = { stage: string; label: string; opened: string | null; closed: string | null; txn: string | null };
type DealThread = {
  subject: string; origin: "inbound" | "pitched"; active: boolean; stale: boolean; declined: boolean;
  hasForm: boolean; qualified: boolean; party: string; partyEmail: string | null;
  budget: string | null; offer: string | null; intent: string | null; outcome: string | null;
  messages: number; first: string; last: string; lastSnippet: string;
};
type DealReport = {
  domain: string; inbound: number; inboundQualified: number; activeNegotiations: number; pitched: number;
  representingSince: string | null; sale: SaleStatus | null; threads: DealThread[];
};
type GaRow = { views: number; sessions: number; users: number; inquiryStarts: number; clicks: number; inquiries: number };
type Newsletter = { count: number; forSale: number; content: number; lastDate: string | null; dates: string[] } | null;
type Resp = {
  ok: boolean; domain: string; from: string; to: string;
  deals: { report: DealReport | null; generatedAt: string | null; configured: boolean };
  ga: GaRow | null; newsletter: Newsletter; error?: string;
};

const CORAL = "var(--coral-deep, #c0492f)";
const NAVY = "var(--navy, #254254)";
const fmt = (x: number) => x.toLocaleString();
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const TODAY = etYmd(new Date());
const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

type Preset = "30" | "90" | "365" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "30", label: "Last 30 days" }, { key: "90", label: "Last 90 days" },
  { key: "365", label: "Last 12 months" }, { key: "all", label: "All time" }, { key: "custom", label: "Custom" },
];

function StatCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "12px 16px", minWidth: 120, flex: "1 1 120px" }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div className="muted" style={{ fontSize: 13.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}
function AggCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? CORAL : "#e3ddcf"}`, borderRadius: 10, padding: "14px 18px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 38, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function statusOf(t: DealThread): { label: string; color: string } {
  if (t.active) return { label: "Active", color: CORAL };
  if (t.declined) return { label: "Declined", color: "#9a3b3b" };
  if (t.stale) return { label: "Stale", color: "#8a8275" };
  if (t.origin === "inbound") return { label: t.qualified ? "Qualified" : "Low-quality", color: t.qualified ? "#2f7d4f" : "#8a8275" };
  return { label: "Pitched", color: "#5a4ec0" };
}

// Compact controls (the dashboard's `.field` class is full-width — too clunky here).
const CTL: React.CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: NAVY, maxWidth: 200, cursor: "pointer" };
const BTN: React.CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: NAVY, cursor: "pointer", whiteSpace: "nowrap" };
const cell: React.CSSProperties = { padding: "10px 14px", borderBottom: "1px solid var(--line, #eee)", verticalAlign: "top", fontSize: 15, lineHeight: 1.45 };
const head: React.CSSProperties = { ...cell, textAlign: "left", color: "var(--muted, #888)", fontWeight: 600, whiteSpace: "nowrap", fontSize: 13.5 };

function StatusBadge({ t }: { t: DealThread }) {
  const s = statusOf(t);
  return <span style={{ fontSize: 12.5, fontWeight: 700, color: s.color, border: `1px solid ${s.color}`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{s.label}</span>;
}

export default function DealClient({ domain }: { domain: string }) {
  const [preset, setPreset] = useState<Preset>("90");
  const [from, setFrom] = useState(etYmd(new Date(Date.now() - 89 * 86400000)));
  const [to, setTo] = useState(TODAY);
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [showLowQ, setShowLowQ] = useState(false);

  const range = useMemo(() => {
    if (preset === "30") return { from: etYmd(new Date(Date.now() - 29 * 86400000)), to: TODAY };
    if (preset === "90") return { from: etYmd(new Date(Date.now() - 89 * 86400000)), to: TODAY };
    if (preset === "365") return { from: etYmd(new Date(Date.now() - 364 * 86400000)), to: TODAY };
    if (preset === "all") return { from: "2024-01-01", to: TODAY };
    return { from, to: to || from };
  }, [preset, from, to]);

  const load = useCallback(async (refresh = false) => {
    setLoading(true); setMsg("");
    try {
      const q = new URLSearchParams({ domain, from: range.from, to: range.to });
      if (refresh) q.set("refresh", "1");
      const res = await fetch(`/api/admin/marketplace/deals?${q.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok || !j.ok) throw new Error(j.error || `Failed (${res.status})`);
      setData(j);
    } catch (e) {
      setMsg(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [domain, range.from, range.to]);

  useEffect(() => { void load(); }, [load]);

  const rep = data?.deals.report;
  const ga = data?.ga;
  const nl = data?.newsletter;
  const threads = rep?.threads || [];

  // Section 1 — inbound inquiries & negotiations (active first, then recency).
  const inboundAll = threads.filter((t) => t.origin === "inbound");
  const lowQ = inboundAll.filter((t) => !t.qualified);
  const rank = (t: DealThread) => (t.active ? 0 : t.declined ? 2 : t.stale ? 3 : 1);
  const inboundShown = inboundAll
    .filter((t) => t.qualified || showLowQ)
    .sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1));
  // Section 2 — pitched (our outreach).
  const pitched = threads.filter((t) => t.origin === "pitched").sort((a, b) => rank(a) - rank(b) || (a.last < b.last ? 1 : -1));

  return (
    <main>
      <div style={{ marginBottom: 6 }}>
        <a href="/reports/marketplace" style={{ color: CORAL, textDecoration: "none", fontSize: 13 }}>← Marketplace</a>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.4rem", margin: 0 }}>{domain}</h1>
        {rep?.sale && (
          <span style={{ fontSize: 13, fontWeight: 700, color: "#fff", background: rep.sale.stage === "sold" ? "#2f7d4f" : CORAL, borderRadius: 999, padding: "2px 12px" }}>
            {rep.sale.stage === "sold" ? `Sold${rep.sale.closed ? ` · ${rep.sale.closed}` : ""}` : rep.sale.label}
          </span>
        )}
        {rep?.representingSince && <span className="muted" style={{ fontSize: 12 }}>Representing since {rep.representingSince}</span>}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "12px 0 4px" }}>
        <span className="muted" style={{ fontSize: 12 }}>Traffic:</span>
        <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} style={CTL}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        {preset === "custom" && (
          <>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)} style={CTL} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)} style={CTL} />
            <button onClick={() => void load(false)} style={BTN} disabled={loading}>Apply</button>
          </>
        )}
        <button onClick={() => void load(true)} style={BTN} disabled={loading} title="Re-scan the mailboxes now (a few minutes)">↻ Regenerate</button>
        {loading && <span className="loading-pulse" style={{ fontSize: 12, color: CORAL }}>working…</span>}
        {!loading && data?.deals.generatedAt && <span className="muted" style={{ fontSize: 12 }}>updated {ago(data.deals.generatedAt)}</span>}
      </div>

      {msg && <p style={{ color: CORAL }}>{msg}</p>}
      {data?.deals.configured === false && <p className="muted">Gmail isn&apos;t configured on this deployment (GOOGLE_SA_KEY).</p>}
      {loading && !rep && <p className="loading-pulse" style={{ color: CORAL }}>Generating the activity report — scanning the deal mailboxes for this domain. This can take a few minutes the first time…</p>}

      <h2 style={{ fontSize: "1.18rem", margin: "16px 0 6px" }}>Traffic <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({range.from === range.to ? range.from : `${range.from} → ${range.to}`})</span></h2>
      {ga ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Visits" value={ga.views} /><StatCard label="Visitors" value={ga.users} />
          <StatCard label="Sessions" value={ga.sessions} /><StatCard label="Inquiries (GA)" value={ga.inquiries} accent />
        </div>
      ) : <p className="muted" style={{ fontSize: 13 }}>No GA traffic for this window.</p>}

      {rep && (
        <>
          <h2 style={{ fontSize: "1.18rem", margin: "20px 0 6px" }}>Deal activity <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(all-time, from email)</span></h2>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <AggCard label="Inbound inquiries" value={rep.inboundQualified} sub={`${rep.inbound} total incl. low-quality`} accent />
            <AggCard label="Active negotiations" value={rep.activeNegotiations} sub="live two-way (≤45d, not declined)" />
            <AggCard label="Pitched to buyers" value={rep.pitched} sub="our proactive outreach" />
          </div>
          {nl && nl.count > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              Newsletter: <strong>{nl.forSale}</strong>× Monthly Spotlight · <strong>{nl.content}</strong>× weekly content{nl.lastDate ? ` · last ${nl.lastDate}` : ""}
            </p>
          )}

          {/* Section 1: Inbound & negotiations */}
          <h3 style={{ fontSize: 16.5, margin: "20px 0 4px" }}>Inbound inquiries &amp; negotiations</h3>
          {inboundShown.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>None.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={head}>Buyer</th><th style={head}>Offer</th><th style={head}>Status</th><th style={head}>Last activity</th><th style={{ ...head, width: "42%" }}>What happened</th></tr></thead>
                <tbody>
                  {inboundShown.map((t, i) => (
                    <tr key={i}>
                      <td style={cell}><div style={{ fontWeight: 600 }}>{t.party}</div>{t.partyEmail && <div className="muted" style={{ fontSize: 11 }}>{t.partyEmail}</div>}</td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>
                        {t.offer
                          ? <span style={{ fontWeight: 700, color: NAVY }}>{t.offer}</span>
                          : t.budget
                            ? <span className="muted" title="Budget band (not a firm offer)">{t.budget}</span>
                            : <span className="muted">—</span>}
                      </td>
                      <td style={cell}><StatusBadge t={t} /></td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{t.last}<span className="muted" style={{ fontSize: 11 }}> · {t.messages} msg</span></td>
                      <td style={cell}>{t.outcome || <span className="muted">{t.lastSnippet || "—"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {lowQ.length > 0 && (
            <button onClick={() => setShowLowQ((v) => !v)} className="field" style={{ marginTop: 8, padding: "4px 12px", fontSize: 12, cursor: "pointer" }}>
              {showLowQ ? "Hide" : "Show"} {lowQ.length} low-quality inquir{lowQ.length === 1 ? "y" : "ies"}
            </button>
          )}

          {/* Section 2: Pitched */}
          <h3 style={{ fontSize: 16.5, margin: "24px 0 4px" }}>Pitched to buyers</h3>
          {pitched.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>None.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <thead><tr><th style={head}>Pitched to</th><th style={head}>Status</th><th style={head}>Last contact</th><th style={{ ...head, width: "48%" }}>What happened</th></tr></thead>
                <tbody>
                  {pitched.map((t, i) => (
                    <tr key={i}>
                      <td style={cell}><div style={{ fontWeight: 600 }}>{t.party}</div>{t.partyEmail && <div className="muted" style={{ fontSize: 11 }}>{t.partyEmail}</div>}</td>
                      <td style={cell}><StatusBadge t={t} /></td>
                      <td style={{ ...cell, whiteSpace: "nowrap" }}>{t.last}<span className="muted" style={{ fontSize: 11 }}> · {t.messages} msg</span></td>
                      <td style={cell}>{t.outcome || <span className="muted">{t.lastSnippet || "—"}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!loading && !rep && data && <p className="muted" style={{ fontSize: 13 }}>No deal data.</p>}
    </main>
  );
}
