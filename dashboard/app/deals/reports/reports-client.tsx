"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STATUSES, SOURCES, PRIORITIES, BUDGET_BANDS, statusLabel } from "@/lib/deals/stages";

type Deal = {
  id: string; domain: string; buyer_name: string | null; buyer_email: string | null; org_name: string | null;
  budget_range: string | null; asking_price: number | null; appraisal_value: number | null;
  source: string | null; heard_about: string | null; priority: string | null; owner_email: string | null; stage: string; status: string; created_at: string;
};
type Agg = { count: number; askingTotal: number; byStage: Record<string, number>; byOwner: Record<string, number>; byStatus: Record<string, number> };
type Resp = { ok: boolean; deals: Deal[]; aggregates: Agg; assignees: { email: string; name: string }[]; error?: string };

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const input: CSSProperties = { padding: "6px 8px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 13.5, boxSizing: "border-box", width: "100%" };
const lbl: CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
const th: CSSProperties = { textAlign: "left", padding: "0 12px 6px 0", fontSize: 11, textTransform: "uppercase", color: "var(--muted,#889)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "7px 12px 7px 0", fontSize: 13, borderTop: "1px solid var(--line,#eee)", whiteSpace: "nowrap" };
const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const stat: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 10, padding: "10px 14px", minWidth: 120 };

const EMPTY: Record<string, string> = { status: "", owner: "", stage: "", source: "", heardAbout: "", priority: "", budgetBand: "", minAsking: "", maxAsking: "", q: "", from: "", to: "" };

export default function ReportsClient() {
  const router = useRouter();
  const [f, setF] = useState({ ...EMPTY });
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const run = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    for (const k of Object.keys(f)) { const v = (f as Record<string, string>)[k]; if (v) p.set(k, v); }
    try { const res = await fetch(`/api/admin/deals/report?${p}`, { cache: "no-store" }); setData(await res.json()); }
    finally { setLoading(false); }
  }, [f]);
  useEffect(() => { run(); /* initial (unfiltered) */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nameFor = useMemo(() => {
    const m = new Map((data?.assignees || []).map((a) => [a.email.toLowerCase(), a.name]));
    return (e: string | null) => e ? (m.get(e.toLowerCase()) || e.split("@")[0]) : "Inbox";
  }, [data]);
  const deals = data?.deals || [];
  const agg = data?.aggregates;

  const exportCsv = () => {
    const head = ["domain", "buyer", "email", "company", "owner", "stage", "status", "budget", "asking", "appraisal", "source", "heard_about", "priority", "created"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = deals.map((d) => [d.domain, d.buyer_name, d.buyer_email, d.org_name, nameFor(d.owner_email), d.stage, d.status, d.budget_range, d.asking_price, d.appraisal_value, d.source, d.heard_about, d.priority, d.created_at?.slice(0, 10)].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deals-report.csv"; a.click();
  };

  return (
    <main style={{ width: "100%", padding: "0 12px", boxSizing: "border-box" }}>
      <h1 style={{ fontSize: "1.35rem", margin: "0 0 10px" }}>Deals — reporting</h1>

      {/* Filters */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(150px,1fr))", gap: 10, marginBottom: 12 }}>
        <div><span style={lbl}>Status</span><select style={input} value={f.status} onChange={(e) => set("status", e.target.value)}><option value="">Any</option>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></div>
        <div><span style={lbl}>Owner</span><select style={input} value={f.owner} onChange={(e) => set("owner", e.target.value)}><option value="">Anyone</option><option value="__inbox__">Unassigned</option>{(data?.assignees || []).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}</select></div>
        <div><span style={lbl}>Stage</span><select style={input} value={f.stage} onChange={(e) => set("stage", e.target.value)}><option value="">Any</option>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Source</span><select style={input} value={f.source} onChange={(e) => set("source", e.target.value)}><option value="">Any</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Heard about</span><input style={input} value={f.heardAbout} onChange={(e) => set("heardAbout", e.target.value)} placeholder="e.g. X / Twitter" /></div>
        <div><span style={lbl}>Priority</span><select style={input} value={f.priority} onChange={(e) => set("priority", e.target.value)}><option value="">Any</option>{PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Budget</span><select style={input} value={f.budgetBand} onChange={(e) => set("budgetBand", e.target.value)}><option value="">Any</option>{BUDGET_BANDS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Min asking $</span><input style={input} value={f.minAsking} onChange={(e) => set("minAsking", e.target.value)} placeholder="0" /></div>
        <div><span style={lbl}>Max asking $</span><input style={input} value={f.maxAsking} onChange={(e) => set("maxAsking", e.target.value)} placeholder="—" /></div>
        <div><span style={lbl}>From</span><input style={input} type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></div>
        <div><span style={lbl}>To</span><input style={input} type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        <div><span style={lbl}>Search</span><input style={input} value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="domain / buyer" /></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button style={{ ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" }} onClick={run} disabled={loading}>{loading ? "Running…" : "Run report"}</button>
        <button style={btn} onClick={() => { setF({ ...EMPTY }); setTimeout(run, 0); }}>Clear</button>
        <button style={btn} onClick={exportCsv} disabled={!deals.length}>Export CSV</button>
      </div>

      {/* Aggregates */}
      {agg && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div style={stat}><div style={{ fontSize: 22, fontWeight: 800 }}>{agg.count}</div><div className="muted" style={{ fontSize: 12 }}>deals</div></div>
          <div style={stat}><div style={{ fontSize: 22, fontWeight: 800 }}>{usd(agg.askingTotal)}</div><div className="muted" style={{ fontSize: 12 }}>total asking</div></div>
          <div style={{ ...stat, minWidth: 200 }}><div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>BY STATUS</div>{Object.entries(agg.byStatus).map(([k, v]) => <span key={k} style={{ fontSize: 12.5, marginRight: 10 }}>{statusLabel(k)}: <b>{v}</b></span>)}</div>
          <div style={{ ...stat, minWidth: 240, maxWidth: 420 }}><div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>BY OWNER</div>{(Object.entries(agg.byOwner) as [string, number][]).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span key={k} style={{ fontSize: 12.5, marginRight: 10 }}>{nameFor(k === "Inbox" ? null : k)}: <b>{v}</b></span>)}</div>
        </div>
      )}

      {/* Results */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><th style={th}>Domain</th><th style={th}>Buyer</th><th style={th}>Owner</th><th style={th}>Stage</th><th style={th}>Status</th><th style={th}>Budget</th><th style={th}>Asking</th><th style={th}>Source</th><th style={th}>Heard about</th><th style={th}>Created</th></tr></thead>
          <tbody>
            {deals.map((d) => (
              <tr key={d.id} onClick={() => router.push(`/deals/${d.id}`)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, fontWeight: 700, color: "var(--navy,#254254)" }}>{d.domain}</td>
                <td style={td}>{d.buyer_name || d.buyer_email || "—"}</td>
                <td style={td}>{nameFor(d.owner_email)}</td>
                <td style={td}>{d.stage}</td>
                <td style={{ ...td, fontWeight: 600, color: d.status === "won" ? "#1f7a5a" : d.status === "lost" ? "#a83265" : "inherit" }}>{d.status}</td>
                <td style={td}>{d.budget_range || "—"}</td>
                <td style={td}>{usd(d.asking_price || d.appraisal_value)}</td>
                <td style={td}>{d.source || "—"}</td>
                <td style={td}>{d.heard_about || "—"}</td>
                <td style={{ ...td, color: "var(--muted,#889)" }}>{d.created_at?.slice(0, 10)}</td>
              </tr>
            ))}
            {!deals.length && !loading && <tr><td style={{ ...td, color: "var(--muted,#aab)" }} colSpan={10}>No deals match.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
