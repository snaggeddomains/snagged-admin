"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
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

// Full name → first / last (first token = first name, remainder = last name; a single-token
// name like "NameFind" reads as a first name with a blank last).
const firstOf = (n: string) => (n || "").trim().split(/\s+/)[0] || "";
const lastOf = (n: string) => { const p = (n || "").trim().split(/\s+/); return p.length > 1 ? p.slice(1).join(" ") : ""; };
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : "");

// House sort pattern: COLS metadata + {col,dir}; numeric cols default desc, string asc, blanks last.
type ColKey = "first" | "last" | "company" | "email" | "phone" | "deals" | "notes" | "updated";
const COLS: { key: ColKey; label: string; num?: boolean }[] = [
  { key: "first", label: "First name" },
  { key: "last", label: "Last name" },
  { key: "company", label: "Company" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "deals", label: "Deals", num: true },
  { key: "notes", label: "Notes" },
  { key: "updated", label: "Updated", num: true },
];
function cellVal(o: Owner, k: ColKey): string | number {
  switch (k) {
    case "first": return firstOf(o.name);
    case "last": return lastOf(o.name);
    case "company": return o.company || "";
    case "email": return (o.emails || [])[0] || "";
    case "phone": return (o.phones || [])[0] || "";
    case "deals": return o.deal_count || 0;
    case "notes": return (o.notes || o.negotiation_notes || "").replace(/\s+/g, " ").trim();
    case "updated": return o.updated_at ? Date.parse(o.updated_at) : 0;
  }
}

export default function OwnersClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [sort, setSort] = useState<{ col: ColKey; dir: "asc" | "desc" }>({ col: "deals", dir: "desc" });

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

  const toggleSort = (col: ColKey) => setSort((s) => s.col === col ? { col, dir: s.dir === "asc" ? "desc" : "asc" } : { col, dir: COLS.find((c) => c.key === col)?.num ? "desc" : "asc" });

  const owners = useMemo(() => {
    const rows = [...(data?.owners || [])];
    const { col, dir } = sort;
    const num = !!COLS.find((c) => c.key === col)?.num;
    rows.sort((a, b) => {
      const av = cellVal(a, col), bv = cellVal(b, col);
      const aEmpty = av === "" || av === 0, bEmpty = bv === "" || bv === 0;
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;            // blanks always last
      if (bEmpty) return -1;
      const cmp = num ? (av as number) - (bv as number) : String(av).localeCompare(String(bv));
      return dir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [data, sort]);

  const th: CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".02em", color: "var(--navy-2,#4a5b66)", borderBottom: "2px solid var(--line,#e3ddcf)", cursor: "pointer", whiteSpace: "nowrap", userSelect: "none" };
  const td: CSSProperties = { padding: "9px 10px", fontSize: 13.5, borderBottom: "1px solid var(--line,#eee6d6)", color: "var(--navy,#254254)", verticalAlign: "top" };

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "0 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Domain owners</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Everyone we&apos;ve worked with to acquire a name — contact info + how they negotiate. Built up over deals; confirmed via Owner Review or when a deal reaches Negotiating.</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, minWidth: 200 }} placeholder="Search name / company / email…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button style={btnPrimary} onClick={() => setShowNew(true)}>+ New owner</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load owners: {err}</div>}
      {data && data.configured === false && <div style={{ margin: "12px 0" }} className="muted">The owner directory isn&apos;t set up yet — run <code>scripts/deals.sql</code>.</div>}

      <div style={{ marginTop: 14, overflowX: "auto", border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, background: "var(--paper,#fff)" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
          <thead>
            <tr>
              {COLS.map((c) => {
                const active = sort.col === c.key;
                return (
                  <th key={c.key} style={{ ...th, color: active ? "var(--coral,#e2674a)" : th.color, textAlign: c.num ? "right" : "left" }} onClick={() => toggleSort(c.key)}>
                    {c.label}{active ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {owners.map((o) => (
              <tr key={o.id} onClick={() => router.push(`/deals/owners/${o.id}`)} style={{ cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-2,#f7f5ef)")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <td style={{ ...td, fontWeight: 700 }}>{firstOf(o.name) || "—"}</td>
                <td style={{ ...td, fontWeight: 700 }}>{lastOf(o.name) || <span style={{ color: "var(--muted,#aab)" }}>—</span>}</td>
                <td style={td}>{o.company || <span style={{ color: "var(--muted,#aab)" }}>—</span>}</td>
                <td style={td}>{(o.emails || [])[0] ? <span>{o.emails[0]}{o.emails.length > 1 ? <span style={{ color: "var(--muted,#8a94a0)" }}> +{o.emails.length - 1}</span> : ""}</span> : <span style={{ color: "var(--muted,#aab)" }}>—</span>}</td>
                <td style={td}>{(o.phones || [])[0] || <span style={{ color: "var(--muted,#aab)" }}>—</span>}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 700 }}>{o.deal_count || 0}</td>
                <td style={{ ...td, maxWidth: 320 }}><span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const, overflow: "hidden", color: "var(--muted,#6b7680)", fontSize: 12.5 }}>{(o.notes || o.negotiation_notes || "").trim() || "—"}</span></td>
                <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap", color: "var(--muted,#8a94a0)", fontSize: 12.5 }}>{when(o.updated_at)}</td>
              </tr>
            ))}
            {!loading && !owners.length && !err && (
              <tr><td colSpan={COLS.length} style={{ ...td, textAlign: "center", padding: "20px 10px", color: "var(--muted,#8a94a0)" }}>{q ? "No owners match that search." : "No owners yet — they build up via Owner Review / when a deal reaches Negotiating (or add one now)."}</td></tr>
            )}
          </tbody>
        </table>
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

  // Match-to-existing typeahead — so filling in a name that's already in the directory opens
  // that owner instead of creating a duplicate.
  const [hits, setHits] = useState<{ id: string; name: string; email: string | null; company: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const term = f.name.trim();
    if (term.length < 2) { setHits([]); return; }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/deals/owners?typeahead=${encodeURIComponent(term)}`);
        const j = await res.json();
        if (!dead && Array.isArray(j.owners)) { setHits(j.owners); setOpen(true); }
      } catch { /* ignore */ }
    }, 220);
    return () => { dead = true; clearTimeout(t); };
  }, [f.name]);
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
        <div style={{ position: "relative" }}>
          <input style={{ ...input, width: "100%" }} value={f.name} autoComplete="off" onChange={(e) => set("name", e.target.value)}
            onFocus={() => { if (hits.length) setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Person or company" />
          {open && hits.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10, background: "var(--paper,#fff)", border: "1px solid var(--line,#e3ddcf)", borderRadius: 8, marginTop: 3, boxShadow: "0 6px 18px rgba(20,25,30,0.12)", maxHeight: 220, overflowY: "auto" }}>
              <div style={{ padding: "5px 10px", fontSize: 11, color: "var(--muted,#8a94a0)", borderBottom: "1px solid var(--line,#eee6d6)" }}>Already in the directory — open instead of duplicating</div>
              {hits.map((h) => (
                <button key={h.id} type="button" onMouseDown={(e) => { e.preventDefault(); onCreated(h.id); }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: "transparent", border: "none", cursor: "pointer", fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>{h.name}</span>{(h.email || h.company) && <span style={{ color: "var(--muted,#8a94a0)" }}>{" · "}{[h.email, h.company].filter(Boolean).join(" · ")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
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
