"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STATUSES, SOURCES, PRIORITIES, BUDGET_BANDS, statusLabel } from "@/lib/deals/stages";

type Deal = {
  id: string; domain: string; buyer_name: string | null; buyer_email: string | null; org_name: string | null;
  budget_range: string | null; asking_price: number | null; appraisal_value: number | null;
  source: string | null; heard_about: string | null; intent: string | null; priority: string | null; owner_email: string | null; stage: string; status: string; created_at: string;
  sam_split: boolean | null; sam_split_at: string | null;
};
type Agg = { count: number; askingTotal: number; byStage: Record<string, number>; byOwner: Record<string, number>; byStatus: Record<string, number> };
type Resp = { ok: boolean; deals: Deal[]; aggregates: Agg; assignees: { email: string; name: string }[]; error?: string };

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const input: CSSProperties = { padding: "6px 8px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 13.5, boxSizing: "border-box", width: "100%" };
const lbl: CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "0 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
const th: CSSProperties = { textAlign: "left", padding: "0 12px 6px 0", fontSize: 11, textTransform: "uppercase", color: "var(--muted,#889)", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" };
const td: CSSProperties = { padding: "7px 12px 7px 0", fontSize: 13, borderTop: "1px solid var(--line,#eee)", whiteSpace: "nowrap" };
const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const stat: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 10, padding: "10px 14px", minWidth: 120 };

const EMPTY: Record<string, string> = { status: "", owner: "", stage: "", source: "", heardAbout: "", intent: "", priority: "", budgetBand: "", minAsking: "", maxAsking: "", q: "", from: "", to: "", samSplit: "" };

const value = (d: Deal) => d.asking_price || d.appraisal_value || 0;

// Date-range presets → {from,to} (local YYYY-MM-DD). "all" clears the range.
const DATE_PRESETS: { key: string; label: string }[] = [
  { key: "all", label: "All time" }, { key: "7d", label: "Last 7 days" }, { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" }, { key: "mtd", label: "This month" }, { key: "lastmonth", label: "Last month" },
  { key: "ytd", label: "Year to date" }, { key: "12m", label: "Last 12 months" }, { key: "custom", label: "Custom…" },
];
function presetRange(key: string): { from: string; to: string } {
  const today = new Date();
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const back = (days: number) => { const s = new Date(today); s.setDate(today.getDate() - days); return s; };
  switch (key) {
    case "7d": return { from: fmt(back(6)), to: fmt(today) };
    case "30d": return { from: fmt(back(29)), to: fmt(today) };
    case "90d": return { from: fmt(back(89)), to: fmt(today) };
    case "mtd": return { from: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), to: fmt(today) };
    case "lastmonth": return { from: fmt(new Date(today.getFullYear(), today.getMonth() - 1, 1)), to: fmt(new Date(today.getFullYear(), today.getMonth(), 0)) };
    case "ytd": return { from: `${today.getFullYear()}-01-01`, to: fmt(today) };
    case "12m": { const s = new Date(today); s.setFullYear(today.getFullYear() - 1); return { from: fmt(s), to: fmt(today) }; }
    default: return { from: "", to: "" };
  }
}

// Sortable columns — each maps a header to a comparable value over a row.
type SortKey = "domain" | "buyer" | "owner" | "stage" | "status" | "budget" | "asking" | "source" | "heard" | "intent" | "created" | "sam";
const COLS: { key: SortKey; label: string; num?: boolean }[] = [
  { key: "domain", label: "Domain" }, { key: "buyer", label: "Buyer" }, { key: "owner", label: "Owner" },
  { key: "intent", label: "Intent" }, { key: "stage", label: "Stage" }, { key: "status", label: "Status" }, { key: "budget", label: "Budget" },
  { key: "source", label: "Source" },
  { key: "heard", label: "Heard about" }, { key: "created", label: "Created", num: true }, { key: "sam", label: "Sam split" },
];

// Group-by breakdown fields — value bucket per deal.
const GROUP_FIELDS: { key: string; label: string }[] = [
  { key: "", label: "— none —" }, { key: "intent", label: "Acquire / Sell" }, { key: "heard_about", label: "Heard about" }, { key: "budget_range", label: "Budget" },
  { key: "source", label: "Source" }, { key: "stage", label: "Stage" }, { key: "status", label: "Status" },
  { key: "owner", label: "Owner" }, { key: "priority", label: "Priority" }, { key: "sam_split_month", label: "Sam split — by month taken" },
];

export default function ReportsClient() {
  const router = useRouter();
  const [f, setF] = useState({ ...EMPTY });
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<{ col: SortKey; dir: 1 | -1 }>({ col: "created", dir: -1 });
  const [groupBy, setGroupBy] = useState("");
  const [preset, setPreset] = useState("all");
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // A single "Date range" control → fills from/to. "custom" reveals the two date inputs.
  const onPreset = (key: string) => {
    setPreset(key);
    if (key === "custom") return;                       // keep current dates; reveal inputs
    const { from, to } = presetRange(key);
    setF((s) => ({ ...s, from, to }));
  };

  const run = useCallback(async () => {
    setLoading(true);
    const p = new URLSearchParams();
    for (const k of Object.keys(f)) { const v = (f as Record<string, string>)[k]; if (v) p.set(k, v); }
    try { const res = await fetch(`/api/admin/deals/report?${p}`, { cache: "no-store" }); setData(await res.json()); }
    finally { setLoading(false); }
  }, [f]);
  // Initial load — hydrate filters from the URL query (so a link like
  // /deals/reports?samSplit=yes&from=…&to=… opens pre-filtered), then fetch.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const init: Record<string, string> = { ...EMPTY };
    let any = false;
    for (const k of Object.keys(EMPTY)) { const v = sp.get(k); if (v) { init[k] = v; any = true; } }
    if (any) { setF(init as typeof EMPTY); if (init.from || init.to) setPreset("custom"); }
    const p = new URLSearchParams();
    for (const k of Object.keys(init)) { const v = init[k]; if (v) p.set(k, v); }
    setLoading(true);
    fetch(`/api/admin/deals/report?${p}`, { cache: "no-store" }).then((r) => r.json()).then(setData).finally(() => setLoading(false));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const nameFor = useMemo(() => {
    const m = new Map((data?.assignees || []).map((a) => [a.email.toLowerCase(), a.name]));
    return (e: string | null) => e ? (m.get(e.toLowerCase()) || e.split("@")[0]) : "Inbox";
  }, [data]);
  const deals = data?.deals || [];
  const agg = data?.aggregates;

  // Acquire vs Sell counts over the loaded (filtered/date-ranged) set — for the recap card.
  const byIntent = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of deals) { const k = d.intent || "—"; m[k] = (m[k] || 0) + 1; }
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [deals]);

  const cellVal = useCallback((d: Deal, key: SortKey): string | number => {
    switch (key) {
      case "domain": return d.domain || "";
      case "buyer": return (d.buyer_name || d.buyer_email || "").toLowerCase();
      case "owner": return nameFor(d.owner_email).toLowerCase();
      case "stage": return d.stage || "";
      case "status": return d.status || "";
      case "budget": return d.budget_range || "";
      case "asking": return value(d);
      case "source": return d.source || "";
      case "intent": return (d.intent || "").toLowerCase();
      case "heard": return (d.heard_about || "").toLowerCase();
      case "created": return d.created_at || "";
      case "sam": return d.sam_split ? "yes" : "";
    }
  }, [nameFor]);

  const sorted = useMemo(() => {
    const rows = [...deals];
    rows.sort((a, b) => {
      const av = cellVal(a, sort.col), bv = cellVal(b, sort.col);
      const ae = av === "" || av == null, be = bv === "" || bv == null;
      if (ae && be) return 0; if (ae) return 1; if (be) return -1;   // blanks always last
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * sort.dir;
      return String(av).localeCompare(String(bv)) * sort.dir;
    });
    return rows;
  }, [deals, sort, cellVal]);

  const toggleSort = (col: SortKey) => setSort((s) =>
    s.col === col ? { col, dir: (s.dir === 1 ? -1 : 1) } : { col, dir: COLS.find((c) => c.key === col)?.num ? -1 : 1 });
  const arrow = (col: SortKey) => sort.col === col ? (sort.dir === 1 ? " ▲" : " ▼") : "";

  // Group-by breakdown over the loaded (already-filtered) set.
  const groupVal = useCallback((d: Deal): string => {
    if (groupBy === "owner") return nameFor(d.owner_email);
    if (groupBy === "status") return statusLabel(d.status);
    if (groupBy === "sam_split_month") return d.sam_split && d.sam_split_at ? d.sam_split_at.slice(0, 7) : "— not split —";
    const v = (d as unknown as Record<string, unknown>)[groupBy];
    return (v == null || v === "") ? "—" : String(v);
  }, [groupBy, nameFor]);

  const breakdown = useMemo(() => {
    if (!groupBy) return [];
    const m = new Map<string, { count: number; asking: number }>();
    for (const d of deals) {
      const k = groupVal(d);
      const cur = m.get(k) || { count: 0, asking: 0 };
      cur.count += 1; cur.asking += value(d);
      m.set(k, cur);
    }
    return [...m.entries()].map(([k, v]) => ({ k, ...v })).sort((a, b) => b.count - a.count);
  }, [deals, groupBy, groupVal]);

  const exportCsv = () => {
    const head = ["domain", "buyer", "email", "company", "owner", "intent", "stage", "status", "budget", "asking", "appraisal", "source", "heard_about", "priority", "created", "sam_split", "sam_split_at"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = sorted.map((d) => [d.domain, d.buyer_name, d.buyer_email, d.org_name, nameFor(d.owner_email), d.intent, d.stage, d.status, d.budget_range, d.asking_price, d.appraisal_value, d.source, d.heard_about, d.priority, d.created_at?.slice(0, 10), d.sam_split ? "yes" : "", d.sam_split_at?.slice(0, 10)].map(esc).join(","));
    const blob = new Blob([[head.join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "deals-report.csv"; a.click();
  };
  const exportGroupCsv = () => {
    const label = GROUP_FIELDS.find((g) => g.key === groupBy)?.label || groupBy;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = breakdown.map((b) => [b.k, b.count, `${deals.length ? Math.round((b.count / deals.length) * 100) : 0}%`, b.asking].map(esc).join(","));
    const blob = new Blob([[[label, "deals", "% of deals", "total asking"].join(","), ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `deals-by-${groupBy}.csv`; a.click();
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
        <div><span style={lbl}>Acquire / Sell</span><select style={input} value={f.intent} onChange={(e) => set("intent", e.target.value)}><option value="">Any</option><option value="Acquire">Acquire</option><option value="Sell">Sell</option></select></div>
        <div><span style={lbl}>Priority</span><select style={input} value={f.priority} onChange={(e) => set("priority", e.target.value)}><option value="">Any</option>{PRIORITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Budget</span><select style={input} value={f.budgetBand} onChange={(e) => set("budgetBand", e.target.value)}><option value="">Any</option>{BUDGET_BANDS.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Sam split</span><select style={input} value={f.samSplit} onChange={(e) => set("samSplit", e.target.value)} title="When set to Yes, the date range counts the month Sam TOOK it on (sam_split_at)"><option value="">Any</option><option value="yes">Yes</option><option value="no">No</option></select></div>
        <div><span style={lbl}>Min asking $</span><input style={input} value={f.minAsking} onChange={(e) => set("minAsking", e.target.value)} placeholder="0" /></div>
        <div><span style={lbl}>Max asking $</span><input style={input} value={f.maxAsking} onChange={(e) => set("maxAsking", e.target.value)} placeholder="—" /></div>
        <div><span style={lbl}>Date range</span><select style={input} value={preset} onChange={(e) => onPreset(e.target.value)}>{DATE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></div>
        {preset === "custom" && <>
          <div><span style={lbl}>From</span><input style={input} type="date" value={f.from} onChange={(e) => set("from", e.target.value)} /></div>
          <div><span style={lbl}>To</span><input style={input} type="date" value={f.to} onChange={(e) => set("to", e.target.value)} /></div>
        </>}
        <div><span style={lbl}>Search</span><input style={input} value={f.q} onChange={(e) => set("q", e.target.value)} placeholder="domain / buyer" /></div>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "flex-end", flexWrap: "wrap" }}>
        <button style={{ ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" }} onClick={run} disabled={loading}>{loading ? "Running…" : "Run report"}</button>
        <button style={btn} onClick={() => { setF({ ...EMPTY }); setPreset("all"); setTimeout(run, 0); }}>Clear</button>
        <button style={btn} onClick={exportCsv} disabled={!deals.length}>Export CSV</button>
        <div style={{ marginLeft: "auto" }}>
          <span style={lbl}>Group by</span>
          <select style={{ ...input, width: "auto", minWidth: 150 }} value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
            {GROUP_FIELDS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
          </select>
        </div>
      </div>

      {/* Aggregates */}
      {agg && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16, alignItems: "flex-start" }}>
          <div style={stat}><div style={{ fontSize: 22, fontWeight: 800 }}>{agg.count}</div><div className="muted" style={{ fontSize: 12 }}>deals</div></div>
          <div style={{ ...stat, minWidth: 200 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>BY OWNER</div>
            {(Object.entries(agg.byOwner) as [string, number][]).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <div key={k} style={{ fontSize: 12.5, lineHeight: 1.7 }}>{nameFor(k === "Inbox" ? null : k)}: <b>{v}</b></div>
            ))}
          </div>
          {byIntent.length > 0 && (
            <div style={{ ...stat, minWidth: 170 }}>
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>ACQUIRE / SELL</div>
              {byIntent.map(([k, v]) => (
                <div key={k} style={{ fontSize: 12.5, lineHeight: 1.7 }}>{k}: <b>{v}</b></div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Group-by breakdown — over the currently-loaded (filtered/date-ranged) set. */}
      {groupBy && breakdown.length > 0 && (
        <div style={{ ...stat, minWidth: 320, maxWidth: 560, marginBottom: 16, padding: "12px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 }}>
            <div className="muted" style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".02em" }}>
              By {GROUP_FIELDS.find((g) => g.key === groupBy)?.label} · {deals.length} deals
            </div>
            <button style={{ ...btn, padding: "3px 9px", fontSize: 12 }} onClick={exportGroupCsv}>Export</button>
          </div>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <th style={{ ...th, cursor: "default" }}>{GROUP_FIELDS.find((g) => g.key === groupBy)?.label}</th>
              <th style={{ ...th, cursor: "default", textAlign: "right" }}>Deals</th>
              <th style={{ ...th, cursor: "default", textAlign: "right" }}>%</th>
              <th style={{ ...th, cursor: "default", textAlign: "right" }}>Total asking</th>
            </tr></thead>
            <tbody>
              {breakdown.map((b) => (
                <tr key={b.k}>
                  <td style={td}>{b.k}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{b.count}</td>
                  <td style={{ ...td, textAlign: "right", color: "var(--muted,#889)" }}>{deals.length ? Math.round((b.count / deals.length) * 100) : 0}%</td>
                  <td style={{ ...td, textAlign: "right" }}>{usd(b.asking)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Results */}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>{COLS.map((c) => (
            <th key={c.key} style={{ ...th, color: sort.col === c.key ? "var(--coral,#e2674a)" : th.color, textAlign: c.num ? "right" : "left" }} onClick={() => toggleSort(c.key)}>{c.label}{arrow(c.key)}</th>
          ))}</tr></thead>
          <tbody>
            {sorted.map((d) => (
              <tr key={d.id} onClick={() => router.push(`/deals/${d.id}`)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, fontWeight: 700, color: "var(--navy,#254254)" }}>{d.domain}</td>
                <td style={td}>{d.buyer_name || d.buyer_email || "—"}</td>
                <td style={td}>{nameFor(d.owner_email)}</td>
                <td style={td}>{d.intent ? <span style={{ fontWeight: 600, color: d.intent === "Sell" ? "#a83265" : "var(--navy,#254254)" }}>{d.intent}</span> : "—"}</td>
                <td style={td}>{d.stage}</td>
                <td style={{ ...td, fontWeight: 600, color: d.status === "won" ? "#1f7a5a" : d.status === "lost" ? "#a83265" : "inherit" }}>{d.status}</td>
                <td style={td}>{d.budget_range || "—"}</td>
                <td style={td}>{d.source || "—"}</td>
                <td style={td}>{d.heard_about || "—"}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--muted,#889)" }}>{d.created_at?.slice(0, 10)}</td>
                <td style={td}>{d.sam_split ? <span style={{ color: "#1f6b52", fontWeight: 700 }}>✓{d.sam_split_at ? ` ${d.sam_split_at.slice(0, 7)}` : ""}</span> : "—"}</td>
              </tr>
            ))}
            {!deals.length && !loading && <tr><td style={{ ...td, color: "var(--muted,#aab)" }} colSpan={COLS.length}>No deals match.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
