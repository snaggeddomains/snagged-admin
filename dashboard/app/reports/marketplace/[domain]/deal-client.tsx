"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirrors lib/marketplace-deals.ts + lib/ga.ts ListingRow + newsletter summary.
type SaleStatus = { stage: string; label: string; opened: string | null; closed: string | null; txn: string | null };
type DealThread = {
  subject: string; origin: "inbound" | "pitched"; active: boolean; hasForm: boolean; qualified: boolean;
  party: string; partyEmail: string | null; budget: string | null; intent: string | null;
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
      <div style={{ fontSize: 24, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function AggCard({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div style={{ border: `1px solid ${accent ? CORAL : "#e3ddcf"}`, borderRadius: 10, padding: "14px 18px", minWidth: 150, flex: "1 1 150px" }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: accent ? CORAL : NAVY }}>{fmt(value)}</div>
      <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return <span style={{ fontSize: 11, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 8px", whiteSpace: "nowrap" }}>{text}</span>;
}

function ThreadRow({ t }: { t: DealThread }) {
  return (
    <div style={{ borderBottom: "1px solid var(--line, #eee)", padding: "10px 2px" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {t.origin === "inbound" ? <Badge text="Inbound" color="#2f7d4f" /> : <Badge text="Pitched" color="#5a4ec0" />}
        {t.active && <Badge text="Active negotiation" color={CORAL} />}
        {t.qualified && t.origin === "inbound" && <Badge text="Qualified" color={NAVY} />}
        <strong style={{ fontSize: 13 }}>{t.party}</strong>
        {t.budget && <span className="muted" style={{ fontSize: 12 }}>· budget {t.budget}</span>}
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>{t.first === t.last ? t.last : `${t.first} → ${t.last}`} · {t.messages} msg</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
        {t.subject}
        {t.lastSnippet ? <span style={{ opacity: 0.8 }}> — {t.lastSnippet}</span> : null}
      </div>
    </div>
  );
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
  const lowQ = threads.filter((t) => t.origin === "inbound" && !t.qualified);
  const shown = threads.filter((t) => !(t.origin === "inbound" && !t.qualified) || showLowQ);

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

      {/* Window controls (drive the traffic stats) */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "12px 0 4px" }}>
        <span className="muted" style={{ fontSize: 13 }}>Traffic window</span>
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
        <button onClick={() => void load(false)} className="field" style={{ padding: "5px 12px", fontSize: 13, cursor: "pointer" }} disabled={loading}>
          {loading ? "Loading…" : "Apply"}
        </button>
        <button onClick={() => void load(true)} className="field" style={{ padding: "5px 12px", fontSize: 13, cursor: "pointer" }} disabled={loading} title="Re-scan the mailboxes now (a few minutes)">
          Regenerate
        </button>
        {data?.deals.generatedAt && <span className="muted" style={{ fontSize: 12 }}>deal data {ago(data.deals.generatedAt)}</span>}
      </div>

      {msg && <p style={{ color: CORAL }}>{msg}</p>}
      {data?.deals.configured === false && <p className="muted">Gmail isn&apos;t configured on this deployment (GOOGLE_SA_KEY).</p>}
      {loading && !rep && <p className="muted">Generating the activity report — scanning the deal mailboxes for this domain. This can take a few minutes the first time…</p>}

      {/* Traffic (window) */}
      <h2 style={{ fontSize: "1rem", margin: "16px 0 6px" }}>Traffic <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>({range.from === range.to ? range.from : `${range.from} → ${range.to}`})</span></h2>
      {ga ? (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <StatCard label="Visits" value={ga.views} />
          <StatCard label="Visitors" value={ga.users} />
          <StatCard label="Sessions" value={ga.sessions} />
          <StatCard label="Inquiries (GA)" value={ga.inquiries} accent />
        </div>
      ) : <p className="muted" style={{ fontSize: 13 }}>No GA traffic for this window.</p>}

      {/* Deal activity (all-time) */}
      <h2 style={{ fontSize: "1rem", margin: "20px 0 6px" }}>Deal activity <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(all-time, from email)</span></h2>
      {rep ? (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <AggCard label="Inbound inquiries" value={rep.inboundQualified} sub={`${rep.inbound} total incl. low-quality`} accent />
            <AggCard label="Active negotiations" value={rep.activeNegotiations} sub="two-way buyer exchange" />
            <AggCard label="Pitched to buyers" value={rep.pitched} sub="our proactive outreach" />
          </div>

          {nl && nl.count > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
              Newsletter: <strong>{nl.forSale}</strong>× Monthly Spotlight · <strong>{nl.content}</strong>× weekly content
              {nl.lastDate ? ` · last ${nl.lastDate}` : ""}
            </p>
          )}

          <h3 style={{ fontSize: 14, margin: "18px 0 2px" }}>Detail</h3>
          {shown.length === 0 && <p className="muted" style={{ fontSize: 13 }}>No deal threads found for this domain.</p>}
          {shown.map((t, i) => <ThreadRow key={i} t={t} />)}
          {lowQ.length > 0 && (
            <button onClick={() => setShowLowQ((v) => !v)} className="field" style={{ marginTop: 10, padding: "5px 12px", fontSize: 12, cursor: "pointer" }}>
              {showLowQ ? "Hide" : "Show"} {lowQ.length} low-quality inquir{lowQ.length === 1 ? "y" : "ies"}
            </button>
          )}
        </>
      ) : !loading && <p className="muted" style={{ fontSize: 13 }}>No deal data.</p>}
    </main>
  );
}
