"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type Item = {
  id: string; submitted_by: string | null; submitted_by_name: string | null;
  module: string | null; kind: string; title: string; body: string | null;
  status: string; admin_notes: string | null; created_at: string; updated_at: string;
};
type Resp = { ok: boolean; configured?: boolean; items: Item[]; canManage: boolean; modules: string[]; me: string; error?: string };

const KINDS = [
  { value: "tweak", label: "Tweak / improvement" },
  { value: "addition", label: "Addition to a module" },
  { value: "new_module", label: "New module / functionality" },
  { value: "bug", label: "Bug / broken" },
  { value: "other", label: "Other" },
];
const KIND_LABEL: Record<string, string> = Object.fromEntries(KINDS.map((k) => [k.value, k.label]));
const STATUSES = [
  { value: "open", label: "Open" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "shipped", label: "Shipped" },
  { value: "declined", label: "Declined" },
];
const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
const STATUS_HUE: Record<string, string> = { open: "#2f6f7a", planned: "#946200", in_progress: "#3f4a8f", shipped: "#2f7d4f", declined: "#8a94a0" };

const btn: CSSProperties = { padding: "8px 15px", borderRadius: 9, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13.5, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const chip: CSSProperties = { padding: "5px 11px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const input: CSSProperties = { padding: "8px 10px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const L: CSSProperties = { display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", color: "var(--muted,#8a94a0)", margin: "10px 0 3px" };
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : "");

export default function FeedbackClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"queue" | "mine">("mine");
  const [statusF, setStatusF] = useState("open");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const canManage = data?.canManage;
      const p = new URLSearchParams();
      if (canManage && scope === "queue") { p.set("scope", "all"); if (statusF) p.set("status", statusF); if (q) p.set("q", q); }
      else p.set("scope", "mine");
      const res = await fetch(`/api/feedback?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [scope, statusF, q, data?.canManage]);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope, statusF]);
  useEffect(() => { load(); /* initial */ /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const canManage = !!data?.canManage;
  const items = data?.items || [];

  return (
    <div className="wrap" style={{ maxWidth: 820 }}>
      <div style={{ margin: "6px 0 4px" }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>💡 Feedback &amp; Feature Requests</h1>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13.5 }}>See something that&apos;d make a tool better, or want a whole new one? Log it here — pick the area, describe the tweak or idea. Everything lands in one queue.</p>
      </div>

      <SubmitForm modules={data?.modules || []} onSubmitted={() => load()} />

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "22px 0 10px" }}>
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>{canManage && scope === "queue" ? "All requests" : "Your requests"}</h2>
        {canManage && (
          <div style={{ display: "flex", gap: 6, marginLeft: 6 }}>
            <button style={{ ...chip, ...(scope === "queue" ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }} onClick={() => setScope("queue")}>Full queue</button>
            <button style={{ ...chip, ...(scope === "mine" ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }} onClick={() => setScope("mine")}>Mine</button>
          </div>
        )}
        <button style={{ ...chip, marginLeft: "auto" }} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
      </div>

      {canManage && scope === "queue" && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          {[{ value: "all", label: "All" }, ...STATUSES].map((s) => (
            <button key={s.value} style={{ ...chip, ...(statusF === s.value ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }} onClick={() => setStatusF(s.value)}>{s.label}</button>
          ))}
          <input style={{ ...input, width: "auto", minWidth: 160, marginLeft: "auto" }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        </div>
      )}

      {err && <div style={{ color: "#a83265", margin: "10px 0" }}>Couldn&apos;t load: {err}</div>}
      {data && data.configured === false && <div className="muted" style={{ margin: "10px 0" }}>The feedback queue isn&apos;t set up yet — run <code>scripts/feature_requests.sql</code> on the main project.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {items.map((it) => <Row key={it.id} it={it} canManage={canManage} onChanged={load} />)}
        {!loading && !items.length && !err && <div className="muted" style={{ fontSize: 13, padding: "8px 2px" }}>{scope === "mine" || !canManage ? "You haven't logged anything yet — add your first request above." : "Nothing in this view."}</div>}
      </div>
    </div>
  );
}

function SubmitForm({ modules, onSubmitted }: { modules: string[]; onSubmitted: () => void }) {
  const [f, setF] = useState({ module: "", kind: "tweak", title: "", body: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const submit = async () => {
    if (!f.title.trim()) { setMsg("⚠️ Give it a short title."); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      setMsg("✓ Logged — thanks! Rob's been notified.");
      setF({ module: "", kind: "tweak", title: "", body: "" });
      onSubmitted();
    } catch (e) { setMsg(`⚠️ ${String((e as Error)?.message || e)}`); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: "16px 18px", background: "var(--paper,#fff)", marginTop: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <div><label style={L}>Area / module</label>
          <select style={input} value={f.module} onChange={(e) => set("module", e.target.value)}>
            <option value="">— pick an area —</option>
            {modules.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></div>
        <div><label style={L}>Type</label>
          <select style={input} value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select></div>
      </div>
      <label style={L}>Title</label>
      <input style={input} value={f.title} onChange={(e) => set("title", e.target.value)} placeholder="One line — what do you want?" />
      <label style={L}>Details (optional)</label>
      <textarea style={{ ...input, minHeight: 80, resize: "vertical" }} value={f.body} onChange={(e) => set("body", e.target.value)} placeholder="What should it do, why, an example…" />
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <button style={btnPrimary} onClick={submit} disabled={busy || !f.title.trim()}>{busy ? "Sending…" : "Submit request"}</button>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("✓") ? "#2f7d4f" : "#a83265" }}>{msg}</span>}
      </div>
    </div>
  );
}

function Row({ it, canManage, onChanged }: { it: Item; canManage: boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(it.admin_notes || "");
  const [editingNotes, setEditingNotes] = useState(false);
  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/feedback/${it.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEditingNotes(false);
      onChanged();
    } catch { /* ignore */ } finally { setBusy(false); }
  };
  const hue = STATUS_HUE[it.status] || "#8a94a0";
  return (
    <div style={{ border: "1px solid var(--line,#e3ddcf)", borderRadius: 11, padding: "13px 15px", background: "var(--paper,#fff)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: "var(--navy,#254254)" }}>{it.title}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: hue, borderRadius: 999, padding: "2px 10px", textTransform: "uppercase", letterSpacing: ".03em" }}>{STATUS_LABEL[it.status] || it.status}</span>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "6px 0 2px", fontSize: 12 }}>
        {it.module && <span style={{ background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "2px 9px", color: "var(--navy-2,#4a5b66)", fontWeight: 600 }}>{it.module}</span>}
        <span style={{ color: "var(--muted,#8a94a0)" }}>{KIND_LABEL[it.kind] || it.kind}</span>
      </div>
      {it.body && <div style={{ fontSize: 13.5, color: "var(--navy-2,#4a5b66)", marginTop: 6, whiteSpace: "pre-wrap" }}>{it.body}</div>}
      <div style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)", marginTop: 8 }}>
        {canManage && it.submitted_by_name ? `${it.submitted_by_name} · ` : ""}{when(it.created_at)}
      </div>

      {canManage && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--line,#eee6d6)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--muted,#8a94a0)" }}>Status:</span>
          <select value={it.status} onChange={(e) => patch({ status: e.target.value })} disabled={busy} style={{ ...input, width: "auto", padding: "5px 8px", fontSize: 13 }}>
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {editingNotes ? (
            <>
              <input style={{ ...input, width: "auto", flex: "1 1 220px" }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note to self…" />
              <button style={chip} disabled={busy} onClick={() => patch({ admin_notes: notes })}>Save</button>
            </>
          ) : (
            <button style={chip} onClick={() => setEditingNotes(true)}>{it.admin_notes ? "✎ Note" : "+ Note"}</button>
          )}
          {!editingNotes && it.admin_notes && <span style={{ fontSize: 12.5, color: "var(--navy-2,#4a5b66)" }}>📝 {it.admin_notes}</span>}
        </div>
      )}
    </div>
  );
}
