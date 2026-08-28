"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, PRIORITIES, STATUSES, statusLabel } from "@/lib/snap-deals/stages";

type Deal = {
  id: string; domain: string; point_person: string | null; owner_info: string | null;
  asking_price: number | null; current_offer: number | null; priority: string | null;
  stage: string; status: string; drop_reason: string | null; notes: string | null;
  created_by: string | null; created_at: string; updated_at: string;
};
type Activity = { id: string; user_email: string | null; kind: string; body: string | null; created_at: string };
type Resp = { ok: boolean; deal?: Deal; activity?: Activity[]; error?: string };

const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "12px 0 3px" };
const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const KIND_LABEL: Record<string, string> = { created: "created", stage_change: "moved", status_change: "status", note: "note" };

function ago(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/snap-deals/${id}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const d = data?.deal;
  const startEdit = () => {
    if (!d) return;
    setForm({
      domain: d.domain, owner_info: d.owner_info || "", point_person: d.point_person || "",
      asking_price: d.asking_price != null ? String(d.asking_price) : "", current_offer: d.current_offer != null ? String(d.current_offer) : "",
      priority: d.priority || "Normal", stage: d.stage, status: d.status, notes: d.notes || "",
    });
    setEditing(true);
  };
  const setF = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/snap-deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!res.ok) { const j = await res.json(); throw new Error(j.error || `HTTP ${res.status}`); }
      setEditing(false); await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  };
  const postNote = async () => {
    const text = note.trim(); if (!text) return;
    setNote("");
    try {
      const res = await fetch(`/api/admin/snap-deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", body: text }) });
      const j = await res.json();
      if (res.ok) setData((prev) => prev ? { ...prev, activity: j.activity } : prev);
    } catch { /* ignore */ }
  };
  const remove = async () => {
    if (!confirm("Delete this deal? This can't be undone.")) return;
    await fetch(`/api/admin/snap-deals/${id}`, { method: "DELETE" });
    router.push("/snap-deals");
  };

  if (err) return <main style={{ padding: "0 16px" }}><p style={{ color: "#a83265" }}>{err}</p><button style={btn} onClick={() => router.push("/snap-deals")}>← Board</button></main>;
  if (!d) return <main style={{ padding: "0 16px" }}><p className="muted">Loading…</p></main>;

  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: "0 16px" }}>
      <button style={{ ...btn, border: "none", padding: "4px 0", marginBottom: 6 }} onClick={() => router.push("/snap-deals")}>← SNAP Deals</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{d.domain}</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {d.stage}{d.status !== "open" ? ` · ${statusLabel(d.status).toUpperCase()}${d.drop_reason ? ` (${d.drop_reason})` : ""}` : ""}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!editing && <button style={btn} onClick={startEdit}>✎ Edit</button>}
          {!editing && <button style={{ ...btn, color: "#a83265" }} onClick={remove}>Delete</button>}
        </div>
      </div>

      <div style={{ background: "#fff", border: "1px solid var(--line,#e6e0d3)", borderRadius: 12, padding: "16px 18px", marginTop: 14 }}>
        {editing ? (
          <>
            <label style={fieldLabel}>Domain</label>
            <input style={input} value={form.domain} onChange={setF("domain")} />
            <label style={fieldLabel}>Owner info</label>
            <input style={input} value={form.owner_info} onChange={setF("owner_info")} placeholder="Owner name + contact" />
            <label style={fieldLabel}>Point person</label>
            <input style={input} value={form.point_person} onChange={setF("point_person")} />
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><label style={fieldLabel}>Asking / target $</label><input style={input} value={form.asking_price} onChange={setF("asking_price")} /></div>
              <div style={{ flex: 1 }}><label style={fieldLabel}>Current offer $</label><input style={input} value={form.current_offer} onChange={setF("current_offer")} /></div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><label style={fieldLabel}>Priority</label><select style={input} value={form.priority} onChange={setF("priority")}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
              <div style={{ flex: 1 }}><label style={fieldLabel}>Stage</label><select style={input} value={form.stage} onChange={setF("stage")}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
              <div style={{ flex: 1 }}><label style={fieldLabel}>Status</label><select style={input} value={form.status} onChange={setF("status")}>{STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></div>
            </div>
            <label style={fieldLabel}>Notes</label>
            <textarea style={{ ...input, minHeight: 70, resize: "vertical" }} value={form.notes} onChange={setF("notes")} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button style={btn} onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
              <button style={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
            </div>
          </>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 8, columnGap: 12, fontSize: 14 }}>
            <Field label="Owner">{d.owner_info || <Muted />}</Field>
            <Field label="Point person">{d.point_person || <Muted />}</Field>
            <Field label="Asking / target">{usd(d.asking_price)}</Field>
            <Field label="Current offer">{usd(d.current_offer)}{d.asking_price && d.current_offer ? <span style={{ color: "var(--navy-2,#4a5b66)" }}> · gap {usd(d.asking_price - d.current_offer)}</span> : null}</Field>
            <Field label="Priority">{d.priority || <Muted />}</Field>
            <Field label="Notes">{d.notes ? <span style={{ whiteSpace: "pre-wrap" }}>{d.notes}</span> : <Muted />}</Field>
          </div>
        )}
      </div>

      {/* Progress log */}
      <div style={{ marginTop: 18 }}>
        <h2 style={{ fontSize: "1.05rem", margin: "0 0 8px" }}>Progress</h2>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input style={input} placeholder="Add a progress note…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") postNote(); }} />
          <button style={btnPrimary} onClick={postNote} disabled={!note.trim()}>Post</button>
        </div>
        {(data?.activity || []).length === 0 && <p className="muted" style={{ fontSize: 13 }}>No progress yet.</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(data?.activity || []).slice().reverse().map((a) => (
            <div key={a.id} style={{ display: "flex", gap: 10, alignItems: "baseline", fontSize: 13.5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: a.kind === "note" ? "var(--coral,#c0492f)" : "#8a94a0", minWidth: 54 }}>{KIND_LABEL[a.kind] || a.kind}</span>
              <div style={{ flex: 1 }}>
                <span style={{ whiteSpace: "pre-wrap", color: "var(--navy,#254254)" }}>{a.body}</span>
                <span className="muted" style={{ fontSize: 11.5, marginLeft: 8 }}>{a.user_email ? `${a.user_email.split("@")[0]} · ` : ""}{ago(a.created_at)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (<><div style={{ fontWeight: 700, color: "var(--navy-2,#4a5b66)" }}>{label}</div><div style={{ color: "var(--navy,#254254)" }}>{children}</div></>);
}
function Muted() { return <span className="muted">—</span>; }
