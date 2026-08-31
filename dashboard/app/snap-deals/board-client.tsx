"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, PRIORITIES, PRIORITY_RANK, DROP_REASONS, CLOSED_WON_STAGE, statusLabel } from "@/lib/snap-deals/stages";

type Deal = {
  id: string; domain: string; point_person: string | null; owner_info: string | null;
  asking_price: number | null; current_offer: number | null; priority: string | null;
  stage: string; status: string; drop_reason: string | null; notes: string | null; updated_at: string;
};
type Stats = { open: number; byStage: Record<string, number> };
type Resp = { ok: boolean; configured: boolean; deals: Deal[]; stats: Stats | null; me?: string; error?: string };

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };
const PRIORITY_COLOR: Record<string, string> = { Top: "#a83265", High: "#c0492f", Normal: "#4a5b66", Low: "#8a94a0" };

export default function BoardClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [dropFor, setDropFor] = useState<string | null>(null); // deal id awaiting a drop reason

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (q) p.set("q", q);
      const res = await fetch(`/api/admin/snap-deals?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  // Within a column, float higher-priority deals up (Top → High → Normal → Low → none).
  const byStage = useMemo(() => {
    const rank = (p: string | null) => PRIORITY_RANK[p || ""] ?? 4;
    const m: Record<string, Deal[]> = {};
    for (const s of STAGES) m[s] = [];
    for (const d of data?.deals || []) (m[d.stage] || (m[d.stage] = [])).push(d);
    for (const s of Object.keys(m)) m[s].sort((a, b) => rank(a.priority) - rank(b.priority));
    return m;
  }, [data]);

  const stageDrag = status === "open"; // columns accept drops only in the Open view
  const move = async (id: string, stage: string) => {
    const d = (data?.deals || []).find((x) => x.id === id);
    if (!d || d.stage === stage) return;
    setData((prev) => prev ? { ...prev, deals: prev.deals.map((x) => x.id === id ? { ...x, stage, status: stage === CLOSED_WON_STAGE ? "won" : x.status } : x) } : prev);
    try {
      const res = await fetch(`/api/admin/snap-deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) });
      if (!res.ok) throw new Error();
    } catch { load(); }
  };
  const markDropped = async (id: string, reason: string) => {
    try {
      const res = await fetch(`/api/admin/snap-deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "dropped", drop_reason: reason }) });
      if (!res.ok) throw new Error();
    } finally { load(); }
  };

  return (
    <main style={{ width: "100%", padding: "0 12px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>SNAP Deal Board</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            Internal tracker for names we&apos;re trying to acquire{data?.stats ? ` · ${data.stats.open} open` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, flex: "1 1 160px", minWidth: 140, maxWidth: 240 }} placeholder="Search domain…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <select style={{ ...input, width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option><option value="won">Won</option><option value="dropped">Dropped</option><option value="all">All</option>
          </select>
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button style={btnPrimary} onClick={() => setShowNew(true)}>+ New deal</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load: {err}</div>}
      {data && !data.configured && <div style={{ margin: "12px 0" }} className="muted">The SNAP Deal Board database isn&apos;t set up yet — run <code>scripts/snap_deals.sql</code> on the main project.</div>}

      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 16, marginTop: 14, alignItems: "flex-start" }}>
        {STAGES.map((stage) => {
          const col = byStage[stage] || [];
          const over = dragOver === stage;
          return (
            <div key={stage}
              onDragOver={(e) => { if (stageDrag) { e.preventDefault(); setDragOver(stage); } }}
              onDragLeave={() => setDragOver((s) => s === stage ? null : s)}
              onDrop={(e) => { e.preventDefault(); setDragOver(null); if (stageDrag && dragId) move(dragId, stage); setDragId(null); }}
              style={{ flex: "1 0 210px", minWidth: 210, background: over ? "#eef4f0" : "var(--paper-2,#f4f1ea)", borderRadius: 10, padding: 8, minHeight: 120, border: over ? "1.5px dashed var(--coral,#e2674a)" : "1.5px solid transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px 8px" }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--navy,#254254)" }}>{stage}</span>
                <span style={{ fontSize: 12, color: "var(--muted,#889)" }}>{col.length}</span>
              </div>
              {col.map((d) => (
                <div key={d.id}
                  draggable
                  onDragStart={() => setDragId(d.id)}
                  onDragEnd={() => { setDragId(null); setDragOver(null); }}
                  onClick={() => router.push(`/snap-deals/${d.id}`)}
                  style={{ background: "#fff", border: "1px solid var(--line,#e6e0d3)", borderLeft: `4px solid ${PRIORITY_COLOR[d.priority || ""] || "#c9cdbf"}`, borderRadius: 8, padding: "9px 10px", marginBottom: 8, cursor: "grab", boxShadow: "0 1px 2px rgba(0,0,0,0.04)", opacity: dragId === d.id ? 0.5 : 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)" }}>{d.domain}</span>
                    {d.priority && <span style={{ fontSize: 10.5, fontWeight: 700, color: PRIORITY_COLOR[d.priority] || "#4a5b66" }}>{d.priority}</span>}
                  </div>
                  {d.owner_info && <div style={{ fontSize: 12, color: "var(--navy-2,#4a5b66)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>👤 {d.owner_info}</div>}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6, gap: 6 }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)" }}>{d.point_person ? `▶ ${d.point_person}` : ""}</span>
                    <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy-2,#4a5b66)" }}>
                      {d.current_offer ? `${usd(d.current_offer)} → ` : ""}{usd(d.asking_price)}
                    </span>
                  </div>
                  {d.status !== "open" && <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 4, color: d.status === "won" ? "#1f7a5a" : "#a83265" }}>{statusLabel(d.status).toUpperCase()}{d.status === "dropped" && d.drop_reason ? ` · ${d.drop_reason}` : ""}</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Bottom "Dropped" drop-zone — mark a name we passed on (with a reason). */}
      {status === "open" && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver("__drop__"); }}
          onDragLeave={() => setDragOver((s) => s === "__drop__" ? null : s)}
          onDrop={(e) => { e.preventDefault(); setDragOver(null); if (dragId) { setDropFor(dragId); setDragId(null); } }}
          style={{ marginTop: 4, padding: "12px", borderRadius: 10, textAlign: "center", fontWeight: 700, fontSize: 13, color: dragOver === "__drop__" ? "#fff" : "#a83265", background: dragOver === "__drop__" ? "#a83265" : "#f6edf0", border: "1.5px dashed #d9a3b6" }}>
          🚫 Drop here to mark <em>Dropped</em> (we passed on it)
        </div>
      )}

      {showNew && <NewDealModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {dropFor && <DropModal onCancel={() => setDropFor(null)} onPick={(reason) => { const id = dropFor; setDropFor(null); markDropped(id, reason); }} />}
    </main>
  );
}

function NewDealModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ domain: "", pointPerson: "", ownerInfo: "", askingPrice: "", currentOffer: "", priority: "Normal", stage: "Qualifying", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    if (!f.domain.trim()) { setError("Domain is required."); return; }
    setSaving(true); setError(null);
    try {
      const res = await fetch("/api/admin/snap-deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      onSaved();
    } catch (e) { setError(String((e as Error)?.message || e)); setSaving(false); }
  };
  return (
    <Modal title="New SNAP deal" onClose={onClose}>
      <label style={fieldLabel}>Domain *</label>
      <input style={input} value={f.domain} onChange={set("domain")} placeholder="example.com" autoFocus />
      <label style={fieldLabel}>Owner info</label>
      <input style={input} value={f.ownerInfo} onChange={set("ownerInfo")} placeholder="Owner name + contact (email / phone / link)" />
      <label style={fieldLabel}>Point person</label>
      <input style={input} value={f.pointPerson} onChange={set("pointPerson")} placeholder="Who's running point (e.g. Sam)" />
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><label style={fieldLabel}>Asking / target $</label><input style={input} value={f.askingPrice} onChange={set("askingPrice")} placeholder="e.g. 5000" /></div>
        <div style={{ flex: 1 }}><label style={fieldLabel}>Current offer $</label><input style={input} value={f.currentOffer} onChange={set("currentOffer")} placeholder="e.g. 3000" /></div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><label style={fieldLabel}>Priority</label><select style={input} value={f.priority} onChange={set("priority")}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        <div style={{ flex: 1 }}><label style={fieldLabel}>Stage</label><select style={input} value={f.stage} onChange={set("stage")}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
      </div>
      <label style={fieldLabel}>Notes</label>
      <textarea style={{ ...input, minHeight: 60, resize: "vertical" }} value={f.notes} onChange={set("notes")} placeholder="Any context…" />
      {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 8 }}>{error}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
        <button style={btn} onClick={onClose} disabled={saving}>Cancel</button>
        <button style={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Add deal"}</button>
      </div>
    </Modal>
  );
}

function DropModal({ onCancel, onPick }: { onCancel: () => void; onPick: (reason: string) => void }) {
  const [other, setOther] = useState("");
  return (
    <Modal title="Why are we dropping this?" onClose={onCancel}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {DROP_REASONS.filter((r) => r !== "Other").map((r) => (
          <button key={r} style={{ ...btn, textAlign: "left" }} onClick={() => onPick(r)}>{r}</button>
        ))}
      </div>
      <label style={fieldLabel}>Other reason</label>
      <div style={{ display: "flex", gap: 8 }}>
        <input style={input} value={other} onChange={(e) => setOther(e.target.value)} placeholder="Type a reason…" onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) onPick(other.trim()); }} />
        <button style={btnPrimary} onClick={() => onPick(other.trim() || "Other")}>Drop</button>
      </div>
    </Modal>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,30,40,0.35)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 50, padding: "8vh 16px" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: "20px 22px", width: "min(460px, 100%)", boxShadow: "0 8px 40px rgba(0,0,0,0.2)", maxHeight: "84vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>{title}</h2>
          <button style={{ ...btn, border: "none", fontSize: 18, padding: "0 6px" }} onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
