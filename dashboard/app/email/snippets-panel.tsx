"use client";

import { useCallback, useEffect, useState } from "react";

type Snippet = { id: string; title: string; body: string; updated_at: string };

const NAVY = "#254254";
const CORAL = "#e8735f";

// Reusable-language library for the Email tools. Each snippet can be Inserted (via onInsert, e.g.
// appended to the brief) or Copied to the clipboard. A tucked-away "Manage" section adds/edits/deletes.
// Shared across the team; fail-soft when the table isn't set up yet (renders empty with a hint).
export default function SnippetsPanel({ onInsert }: { onInsert: (text: string) => void }) {
  const [snips, setSnips] = useState<Snippet[] | null>(null);
  const [err, setErr] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [manage, setManage] = useState(false);
  const [editId, setEditId] = useState<string | null>(null); // null = not editing, "" = new
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/email/snippets");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load snippets");
      setSnips(data.snippets || []);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
      setSnips([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const copy = useCallback(async (s: Snippet) => {
    try { await navigator.clipboard.writeText(s.body); setCopiedId(s.id); setTimeout(() => setCopiedId(""), 1500); } catch { /* ignore */ }
  }, []);

  const startNew = () => { setEditId(""); setTitle(""); setBody(""); setErr(""); };
  const startEdit = (s: Snippet) => { setEditId(s.id); setTitle(s.title); setBody(s.body); setErr(""); };
  const cancelEdit = () => { setEditId(null); setTitle(""); setBody(""); };

  const save = useCallback(async () => {
    if (!title.trim() || !body.trim()) { setErr("Title and body are required."); return; }
    setSaving(true); setErr("");
    try {
      const res = await fetch("/api/admin/email/snippets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: editId || undefined, title, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Save failed");
      cancelEdit();
      await load();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  }, [editId, title, body, load]);

  const remove = useCallback(async (s: Snippet) => {
    if (!window.confirm(`Delete snippet "${s.title}"?`)) return;
    try {
      const res = await fetch("/api/admin/email/snippets", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "delete", id: s.id }),
      });
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || "Delete failed"); }
      await load();
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    }
  }, [load]);

  const card: React.CSSProperties = { border: "1px solid #e4e8ec", borderRadius: 10, background: "#fff", padding: 14 };
  const btnSm: React.CSSProperties = { padding: "4px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" };

  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <label style={{ fontSize: 12, fontWeight: 600, color: "#6b7681" }}>🧩 Snippets — reusable language</label>
        <button type="button" onClick={() => { setManage((m) => !m); cancelEdit(); }}
          style={{ ...btnSm, border: "none", background: "none", color: NAVY }}>
          {manage ? "Done" : "Manage"}
        </button>
      </div>

      {err && <div style={{ fontSize: 12.5, color: "#a4271a", marginBottom: 8 }}>{err}</div>}

      {snips == null && <div className="muted" style={{ fontSize: 13 }}>Loading…</div>}
      {snips != null && snips.length === 0 && (
        <div className="muted" style={{ fontSize: 13 }}>
          No snippets yet.{manage ? " Add one below." : " Click Manage to add engagement terms, a recap template, etc."}
        </div>
      )}

      {(snips || []).map((s) => (
        <div key={s.id} style={{ borderTop: "1px solid #f0f3f5", padding: "9px 0" }}>
          {editId === s.id ? (
            <SnippetForm {...{ title, body, setTitle, setBody, save, cancelEdit, saving }} />
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, color: NAVY, fontSize: 13, flex: 1, minWidth: 120 }}>{s.title}</span>
                <button type="button" onClick={() => onInsert(s.body)} style={{ ...btnSm, border: "none", background: CORAL, color: "#fff" }}>→ Insert</button>
                <button type="button" onClick={() => copy(s)} style={{ ...btnSm, border: `1px solid ${NAVY}`, background: "#fff", color: NAVY }}>{copiedId === s.id ? "✓ Copied" : "Copy"}</button>
                {manage && <button type="button" onClick={() => startEdit(s)} style={{ ...btnSm, border: "1px solid #cfd6dc", background: "#fff", color: "#6b7681" }}>Edit</button>}
                {manage && <button type="button" onClick={() => remove(s)} style={{ ...btnSm, border: "1px solid #f0c9c2", background: "#fff", color: "#a4271a" }}>Delete</button>}
              </div>
              <div style={{ fontSize: 12.5, color: "#8a939b", marginTop: 4, whiteSpace: "pre-wrap", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{s.body}</div>
            </>
          )}
        </div>
      ))}

      {manage && editId === "" && (
        <div style={{ borderTop: "1px solid #f0f3f5", paddingTop: 10, marginTop: 4 }}>
          <SnippetForm {...{ title, body, setTitle, setBody, save, cancelEdit, saving }} />
        </div>
      )}
      {manage && editId === null && (
        <button type="button" onClick={startNew} style={{ ...btnSm, marginTop: 8, border: `1px dashed ${NAVY}`, background: "#fff", color: NAVY }}>＋ New snippet</button>
      )}
    </div>
  );
}

function SnippetForm({
  title, body, setTitle, setBody, save, cancelEdit, saving,
}: {
  title: string; body: string;
  setTitle: (v: string) => void; setBody: (v: string) => void;
  save: () => void; cancelEdit: () => void; saving: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Snippet name (e.g. Standard engagement terms)"
        style={{ padding: "7px 10px", border: "1px solid #cfd6dc", borderRadius: 6, fontSize: 13 }} />
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="The reusable language…"
        style={{ padding: "7px 10px", border: "1px solid #cfd6dc", borderRadius: 6, fontSize: 13, resize: "vertical", fontFamily: "inherit" }} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={save} disabled={saving} style={{ padding: "6px 14px", border: "none", borderRadius: 6, background: "#254254", color: "#fff", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={cancelEdit} style={{ padding: "6px 14px", border: "1px solid #cfd6dc", borderRadius: 6, background: "#fff", color: "#6b7681", fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>Cancel</button>
      </div>
    </div>
  );
}
