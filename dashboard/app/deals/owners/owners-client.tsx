"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

type Owner = {
  id: string; name: string; kind: string; company: string | null;
  emails: string[]; phones: string[]; reachability: string | null;
  notes: string | null; negotiation_notes: string | null; deal_count: number; updated_at: string;
};
type Resp = { ok: boolean; configured?: boolean; owners: Owner[]; error?: string };

const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const OWNER_HUES = ["#2f6f7a", "#c0492f", "#6b4a8a", "#2f7d4f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a"];
const hueFor = (k: string) => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return OWNER_HUES[h % OWNER_HUES.length]; };
const initials = (n: string) => { const p = n.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] || "?") + (p[1]?.[0] || "")).toUpperCase(); };

export default function OwnersClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams(); if (q) p.set("q", q);
      const res = await fetch(`/api/admin/deals/owners?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [q]);
  useEffect(() => { load(); }, [load]);

  const owners = data?.owners || [];

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "0 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Domain owners</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Everyone we&apos;ve worked with to acquire a name — contact info + how they negotiate. Built up over deals; confirmed when a deal reaches Negotiating.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, minWidth: 200 }} placeholder="Search name / company / email…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button style={btnPrimary} onClick={() => setShowNew(true)}>+ New owner</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load owners: {err}</div>}
      {data && data.configured === false && <div style={{ margin: "12px 0" }} className="muted">The owner directory isn&apos;t set up yet — run <code>scripts/deals.sql</code>.</div>}

      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
        {owners.map((o) => (
          <button key={o.id} onClick={() => router.push(`/deals/owners/${o.id}`)}
            style={{ textAlign: "left", cursor: "pointer", border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 14, background: "var(--paper,#fff)", display: "flex", gap: 12 }}>
            <span style={{ flex: "none", width: 38, height: 38, borderRadius: "50%", background: hueFor(o.name), color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 700 }}>{initials(o.name)}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ fontWeight: 700, fontSize: 14.5, color: "var(--navy,#254254)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</span>
                <span style={{ flex: "none", fontSize: 11, fontWeight: 700, color: "var(--navy-2,#4a5b66)", background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "1px 8px" }}>{o.deal_count} deal{o.deal_count === 1 ? "" : "s"}</span>
              </div>
              {(o.company || o.kind !== "unknown") && <div style={{ fontSize: 12, color: "var(--muted,#8a94a0)", marginTop: 2 }}>{[o.kind !== "unknown" ? o.kind : null, o.company].filter(Boolean).join(" · ")}</div>}
              {(o.emails || [])[0] && <div style={{ fontSize: 12.5, color: "var(--navy-2,#4a5b66)", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>✉ {o.emails[0]}{o.emails.length > 1 ? ` +${o.emails.length - 1}` : ""}</div>}
              {o.negotiation_notes && <div style={{ fontSize: 12, color: "var(--muted,#8a94a0)", marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden" }}>💬 {o.negotiation_notes}</div>}
            </div>
          </button>
        ))}
        {!loading && !owners.length && !err && <div className="muted" style={{ fontSize: 13, padding: "8px 2px" }}>{q ? "No owners match that search." : "No owners yet — they build up as deals reach Negotiating (or add one now)."}</div>}
      </div>

      {showNew && <NewOwnerModal onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); router.push(`/deals/owners/${id}`); }} />}
    </main>
  );
}

function NewOwnerModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ name: "", kind: "person", company: "", emails: "", phones: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const L: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };
  const submit = async () => {
    if (!f.name.trim()) { setError("Name is required."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/deals/owners", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", name: f.name, kind: f.kind, company: f.company, emails: f.emails, phones: f.phones }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onCreated(j.owner.id);
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(420px,100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 4px" }}>New owner</h2>
        <label style={L}>Name *</label>
        <input style={{ ...input, width: "100%" }} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Person or company" />
        <label style={L}>Type</label>
        <select style={{ ...input, width: "100%" }} value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="person">Person</option><option value="company">Company</option><option value="unknown">Unknown</option></select>
        <label style={L}>Company</label>
        <input style={{ ...input, width: "100%" }} value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Employer / org (if a person)" />
        <label style={L}>Emails <span style={{ fontWeight: 400, color: "var(--muted,#8a94a0)" }}>(comma-separated)</span></label>
        <input style={{ ...input, width: "100%" }} value={f.emails} onChange={(e) => set("emails", e.target.value)} />
        <label style={L}>Phones <span style={{ fontWeight: 400, color: "var(--muted,#8a94a0)" }}>(comma-separated)</span></label>
        <input style={{ ...input, width: "100%" }} value={f.phones} onChange={(e) => set("phones", e.target.value)} />
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btnPrimary} onClick={submit} disabled={busy || !f.name.trim()}>{busy ? "Creating…" : "Create"}</button>
        </div>
      </div>
    </div>
  );
}
