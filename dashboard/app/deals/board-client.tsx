"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, PRIORITIES, SOURCES, BUDGET_BANDS } from "@/lib/deals/stages";

type Deal = {
  id: string; domain: string; buyer_name: string | null; buyer_email: string | null; org_name: string | null;
  budget_range: string | null; appraisal_value: number | null; asking_price: number | null;
  source: string | null; priority: string | null; owner_email: string | null; stage: string; status: string;
  tags: string[] | null; updated_at: string;
};
type Assignee = { email: string; name: string };
type Stats = { open: number; pipelineValue: number; byStage: Record<string, number> };
type Resp = { ok: boolean; configured: boolean; deals: Deal[]; stats: Stats | null; assignees: Assignee[]; canSeeAll: boolean; me: string; error?: string };

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };
const PRIORITY_COLOR: Record<string, string> = { Top: "#a83265", High: "#c0492f", Normal: "#4a5b66", Low: "#8a94a0" };

// Deterministic per-owner color so you can see at a glance who holds what.
const OWNER_PALETTE = ["#2f6f7a", "#6b4a8a", "#2f7d4f", "#c0492f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a", "#8a5a2b", "#4a5b66"];
function ownerColor(email: string | null): string {
  if (!email) return "#b7bcc2";
  let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return OWNER_PALETTE[h % OWNER_PALETTE.length];
}

export default function BoardClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (q) p.set("q", q);
      const res = await fetch(`/api/admin/deals?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  const nameFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data?.assignees || []) m.set(a.email.toLowerCase(), a.name);
    return (email: string | null) => email ? (m.get(email.toLowerCase()) || email.split("@")[0]) : "Inbox";
  }, [data]);

  const deals = useMemo(() => {
    const all = data?.deals || [];
    if (mine && data) return all.filter((d) => (d.owner_email || "").toLowerCase() === data.me.toLowerCase());
    return all;
  }, [data, mine]);

  const byStage = useMemo(() => {
    const m: Record<string, Deal[]> = {};
    for (const s of STAGES) m[s] = [];
    for (const d of deals) (m[d.stage] || (m[d.stage] = [])).push(d);
    return m;
  }, [deals]);

  const dragEnabled = status === "open";
  const move = async (id: string, stage: string) => {
    const d = (data?.deals || []).find((x) => x.id === id);
    if (!d || d.stage === stage) return;
    setData((prev) => prev ? { ...prev, deals: prev.deals.map((x) => x.id === id ? { ...x, stage } : x) } : prev);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) });
      if (!res.ok) throw new Error();
    } catch { load(); }
  };

  return (
    <main style={{ width: "100%", padding: "0 12px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Deal board</h1>
          {data?.stats && <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{data.stats.open} open · {usd(data.stats.pipelineValue)} in pipeline</p>}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, width: 200 }} placeholder="Search domain / buyer…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <select style={{ ...input, width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All</option>
          </select>
          {data?.canSeeAll && (
            <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> My deals
            </label>
          )}
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button style={btnPrimary} onClick={() => setShowNew(true)}>+ New deal</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load deals: {err}</div>}
      {data && !data.configured && <div style={{ margin: "12px 0" }} className="muted">The deals database isn&apos;t set up yet — run <code>scripts/deals.sql</code>.</div>}

      {/* Full-width board: columns grow to fill the window, scroll only when too narrow. */}
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 16, marginTop: 14, alignItems: "flex-start" }}>
        {STAGES.map((stage) => {
          const col = byStage[stage] || [];
          const over = dragOver === stage;
          return (
            <div key={stage}
              onDragOver={(e) => { if (dragEnabled) { e.preventDefault(); setDragOver(stage); } }}
              onDragLeave={() => setDragOver((s) => s === stage ? null : s)}
              onDrop={(e) => { e.preventDefault(); setDragOver(null); if (dragEnabled && dragId) move(dragId, stage); setDragId(null); }}
              style={{ flex: "1 0 210px", minWidth: 210, background: over ? "#eef4f0" : "var(--paper-2,#f4f1ea)", borderRadius: 10, padding: 8, minHeight: 120, border: over ? "1.5px dashed var(--coral,#e2674a)" : "1.5px solid transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px 8px" }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--navy,#254254)" }}>{stage}</span>
                <span style={{ fontSize: 12, color: "var(--muted,#889)" }}>{col.length}</span>
              </div>
              {col.map((d) => {
                const oc = ownerColor(d.owner_email);
                return (
                  <div key={d.id}
                    draggable={dragEnabled}
                    onDragStart={() => setDragId(d.id)}
                    onDragEnd={() => { setDragId(null); setDragOver(null); }}
                    onClick={() => router.push(`/deals/${d.id}`)}
                    style={{ background: "#fff", border: "1px solid var(--line,#e6e0d3)", borderLeft: `4px solid ${oc}`, borderRadius: 8, padding: "9px 10px", marginBottom: 8, cursor: dragEnabled ? "grab" : "pointer", boxShadow: "0 1px 2px rgba(0,0,0,0.04)", opacity: dragId === d.id ? 0.5 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)" }}>{d.domain}</span>
                      {d.priority && <span style={{ fontSize: 10.5, fontWeight: 700, color: PRIORITY_COLOR[d.priority] || "#4a5b66" }}>{d.priority}</span>}
                    </div>
                    {(d.buyer_name || d.buyer_email) && <div style={{ fontSize: 12, color: "var(--navy-2,#4a5b66)", marginTop: 3 }}>{d.buyer_name || d.buyer_email}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: oc, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: oc, display: "inline-block" }} />{nameFor(d.owner_email)}
                      </span>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy-2,#4a5b66)" }}>{d.budget_range || usd(d.asking_price || d.appraisal_value)}</span>
                    </div>
                    {d.status !== "open" && <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 4, color: d.status === "won" ? "#1f7a5a" : "#a83265" }}>{d.status.toUpperCase()}</div>}
                  </div>
                );
              })}
              {!col.length && <div style={{ fontSize: 12, color: "var(--muted,#aab)", textAlign: "center", padding: "10px 0" }}>—</div>}
            </div>
          );
        })}
      </div>

      {showNew && <NewDealModal assignees={data?.assignees || []} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); router.push(`/deals/${id}`); }} />}
    </main>
  );
}

function NewDealModal({ assignees, onClose, onCreated }: { assignees: Assignee[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ domain: "", buyerName: "", buyerEmail: "", orgName: "", budgetRange: "", source: SOURCES[0] as string, priority: "", ownerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async () => {
    if (!f.domain.trim()) { setError("Domain is required."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, domain: f.domain.trim() }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onCreated(j.deal.id);
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(440px,100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 4px" }}>New deal</h2>
        <label style={fieldLabel}>Target domain *</label>
        <input style={input} value={f.domain} onChange={(e) => set("domain", e.target.value)} placeholder="example.com" />
        <label style={fieldLabel}>Buyer name</label>
        <input style={input} value={f.buyerName} onChange={(e) => set("buyerName", e.target.value)} />
        <label style={fieldLabel}>Buyer email</label>
        <input style={input} value={f.buyerEmail} onChange={(e) => set("buyerEmail", e.target.value)} />
        <label style={fieldLabel}>Company</label>
        <input style={input} value={f.orgName} onChange={(e) => set("orgName", e.target.value)} />
        <label style={fieldLabel}>Budget range</label>
        <select style={input} value={f.budgetRange} onChange={(e) => set("budgetRange", e.target.value)}>
          <option value="">—</option>{BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label style={fieldLabel}>Source</label>
        <select style={input} value={f.source} onChange={(e) => set("source", e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <label style={fieldLabel}>Priority</label>
        <select style={input} value={f.priority} onChange={(e) => set("priority", e.target.value)}><option value="">—</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <label style={fieldLabel}>Assign to</label>
        <select style={input} value={f.ownerEmail} onChange={(e) => set("ownerEmail", e.target.value)}>
          <option value="">Unassigned / Inbox</option>
          {assignees.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btnPrimary} onClick={submit} disabled={busy || !f.domain.trim()}>{busy ? "Creating…" : "Create deal"}</button>
        </div>
      </div>
    </div>
  );
}
