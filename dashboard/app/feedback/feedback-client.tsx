"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

type Item = {
  id: string; submitted_by: string | null; submitted_by_name: string | null;
  module: string | null; kind: string; title: string; body: string | null;
  status: string; admin_notes: string | null; attachments: { url: string; name: string; type: string }[] | null; created_at: string; updated_at: string;
  comment_count?: number;
};
type Assignee = { email: string; name: string };
type Comment = { id: string; request_id: string; author_email: string | null; author_name: string | null; body: string | null; mentions: string[] | null; attachments: Att[] | null; created_at: string };
type Resp = { ok: boolean; configured?: boolean; items: Item[]; canManage: boolean; modules: string[]; assignees: Assignee[]; me: string; error?: string };

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
const whenFull = (iso: string) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const AV_HUES = ["#e2674a", "#2f6f7a", "#946200", "#3f4a8f", "#2f7d4f", "#8a4a8f", "#a83265", "#4a5b66"];
const avatarHue = (key: string) => { let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return AV_HUES[h % AV_HUES.length]; };
const initials = (name: string) => (name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";

export default function FeedbackClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusF, setStatusF] = useState("open");
  const [q, setQ] = useState("");
  const [openTicket, setOpenTicket] = useState<string | null>(null);
  useEffect(() => { try { setOpenTicket(new URLSearchParams(window.location.search).get("ticket")); } catch { /* ignore */ } }, []);

  // The server decides the set by role — a manager (Rob) always gets the whole queue (with the
  // status/search filters applied), everyone else gets their own submissions + threads they've
  // joined. So we never send `scope`; we just pass the filters.
  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (statusF && statusF !== "all") p.set("status", statusF);
      if (q) p.set("q", q);
      const res = await fetch(`/api/feedback?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [statusF, q]);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [statusF]);

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
        <h2 style={{ fontSize: "1.05rem", margin: 0 }}>{canManage ? "Feedback queue" : "Your requests"}</h2>
        <button style={{ ...chip, marginLeft: "auto" }} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
      </div>

      {canManage && (
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
        {items.map((it) => <Row key={it.id} it={it} canManage={canManage} onChanged={load} assignees={data?.assignees || []} me={data?.me || ""} defaultOpen={openTicket === it.id} />)}
        {!loading && !items.length && !err && <div className="muted" style={{ fontSize: 13, padding: "8px 2px" }}>{canManage ? "Nothing in this view." : "You haven't logged anything yet — add your first request above."}</div>}
      </div>
    </div>
  );
}

type Att = { url: string; name: string; type: string };
function SubmitForm({ modules, onSubmitted }: { modules: string[]; onSubmitted: () => void }) {
  const [f, setF] = useState({ module: "", kind: "tweak", title: "", body: "" });
  const [atts, setAtts] = useState<Att[]>([]);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const addFiles = async (files: FileList | File[] | null) => {
    const imgs = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setUploading(true); setMsg(null);
    for (const file of imgs.slice(0, 10)) {
      try {
        const fd = new FormData(); fd.append("file", file);
        const res = await fetch("/api/feedback/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (res.ok && j.attachment) setAtts((a) => [...a, j.attachment].slice(0, 10));
        else setMsg(`⚠️ ${j.error || "upload failed"}`);
      } catch { setMsg("⚠️ upload failed"); }
    }
    setUploading(false);
  };

  const submit = async () => {
    if (!f.title.trim()) { setMsg("⚠️ Give it a short title."); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, attachments: atts }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      setMsg("✓ Logged — thanks! Rob's been notified.");
      setF({ module: "", kind: "tweak", title: "", body: "" }); setAtts([]);
      onSubmitted();
    } catch (e) { setMsg(`⚠️ ${String((e as Error)?.message || e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div
      style={{ border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: "16px 18px", background: "var(--paper,#fff)", marginTop: 12 }}
      onPaste={(e) => { const files = Array.from(e.clipboardData?.files || []); if (files.length) { e.preventDefault(); addFiles(files); } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
        <div><label style={L}>Area / module <span style={{ fontWeight: 400, textTransform: "none", letterSpacing: 0 }}>(optional)</span></label>
          <select style={input} value={f.module} onChange={(e) => set("module", e.target.value)}>
            <option value="">— pick an area (optional) —</option>
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
      <textarea style={{ ...input, minHeight: 80, resize: "vertical" }} value={f.body} onChange={(e) => set("body", e.target.value)} placeholder="What should it do, why, an example… (you can paste or drop a screenshot here)" />

      <label style={L}>Screenshots (optional)</label>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <label style={{ ...chip, cursor: "pointer" }}>
          📎 Add image
          <input type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
        </label>
        <span style={{ fontSize: 12, color: "var(--muted,#8a94a0)" }}>{uploading ? "Uploading…" : "or paste / drop into this box"}</span>
      </div>
      {atts.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {atts.map((a, i) => (
            <span key={a.url} style={{ position: "relative", display: "inline-block" }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={a.name} style={{ width: 66, height: 66, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)" }} />
              <button onClick={() => setAtts((s) => s.filter((_, j) => j !== i))} aria-label="Remove"
                style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "none", background: "var(--navy,#254254)", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
        <button style={btnPrimary} onClick={submit} disabled={busy || uploading || !f.title.trim()}>{busy ? "Sending…" : "Submit request"}</button>
        {msg && <span style={{ fontSize: 13, color: msg.startsWith("✓") ? "#2f7d4f" : "#a83265" }}>{msg}</span>}
      </div>
    </div>
  );
}

function Row({ it, canManage, onChanged, assignees, me, defaultOpen }: { it: Item; canManage: boolean; onChanged: () => void; assignees: Assignee[]; me: string; defaultOpen?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(it.admin_notes || "");
  const [editingNotes, setEditingNotes] = useState(false);
  const [showThread, setShowThread] = useState(!!defaultOpen);
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
      {(it.attachments || []).length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {(it.attachments || []).map((a) => (
            <a key={a.url} href={a.url} target="_blank" rel="noopener" title={a.name}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url} alt={a.name} style={{ width: 88, height: 66, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)" }} />
            </a>
          ))}
        </div>
      )}
      {canManage && it.submitted_by_name ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span style={{ flex: "0 0 auto", width: 28, height: 28, borderRadius: "50%", background: avatarHue(it.submitted_by || it.submitted_by_name), color: "#fff", fontSize: 12, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials(it.submitted_by_name)}</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--navy,#254254)" }}>{it.submitted_by_name}</span>
          <span style={{ fontSize: 12, color: "var(--muted,#8a94a0)" }}>· {when(it.created_at)}</span>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)", marginTop: 8 }}>{when(it.created_at)}</div>
      )}

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

      <div style={{ marginTop: 10 }}>
        <button style={{ ...chip, padding: "4px 10px", fontSize: 12.5 }} onClick={() => setShowThread((s) => !s)}>
          {showThread ? "▾" : "▸"} 💬 {it.comment_count ? `${it.comment_count} comment${it.comment_count === 1 ? "" : "s"}` : "Discuss / ask a question"}
        </button>
        {showThread && <Thread requestId={it.id} assignees={assignees} me={me} onPosted={onChanged} />}
      </div>
    </div>
  );
}

// Resolve @tokens typed in the body to assignee emails (first name / squished full name / handle) —
// same behavior as the Deals comment box, so typing "@Sam" loops Sam in. Merged with chip picks.
function resolveMentions(text: string, assignees: Assignee[]): string[] {
  const tokens = [...text.matchAll(/@([\w.]+)/g)].map((m) => m[1].toLowerCase());
  if (!tokens.length) return [];
  const out = new Set<string>();
  for (const a of assignees) {
    const first = a.name.split(/\s+/)[0].toLowerCase();
    const full = a.name.toLowerCase().replace(/\s+/g, "");
    const handle = a.email.split("@")[0].toLowerCase();
    if (tokens.some((t) => t === first || t === full || t === handle)) out.add(a.email);
  }
  return [...out];
}

function Thread({ requestId, assignees, me, onPosted }: { requestId: string; assignees: Assignee[]; me: string; onPosted: () => void }) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [atts, setAtts] = useState<Att[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mq, setMq] = useState<string | null>(null);   // active @-typeahead query
  const [mqIdx, setMqIdx] = useState(0);               // highlighted row in the @-typeahead
  const taRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/feedback/${requestId}/comments`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setComments(j.comments || []);
    } catch (e) { setErr(String((e as Error)?.message || e)); setComments([]); }
  }, [requestId]);
  useEffect(() => { load(); }, [load]);

  const pool = assignees.filter((a) => a.email.toLowerCase() !== me.toLowerCase());
  const nameFor = (email: string | null) => assignees.find((a) => a.email.toLowerCase() === (email || "").toLowerCase())?.name || email || "Someone";
  const toggleTag = (email: string) => setTags((t) => (t.includes(email) ? t.filter((x) => x !== email) : [...t, email]));
  // Everyone who'll be notified = chip picks ∪ @tokens resolved from the body.
  const mentionEmails = [...new Set([...tags, ...resolveMentions(text, assignees)])];

  const addFiles = async (files: FileList | File[] | null) => {
    const imgs = Array.from(files || []).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setUploading(true); setErr(null);
    for (const file of imgs.slice(0, 10)) {
      try {
        const fd = new FormData(); fd.append("file", file);
        const res = await fetch("/api/feedback/upload", { method: "POST", body: fd });
        const j = await res.json();
        if (res.ok && j.attachment) setAtts((a) => [...a, j.attachment].slice(0, 10));
        else setErr(j.error || "upload failed");
      } catch { setErr("upload failed"); }
    }
    setUploading(false);
  };

  const onTextChange = (v: string) => {
    setText(v);
    const caret = taRef.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/@([\w.]*)$/);
    setMq(m ? m[1].toLowerCase() : null);
    setMqIdx(0);
  };
  const pickMention = (a: Assignee) => {
    const el = taRef.current; const caret = el?.selectionStart ?? text.length;
    const token = a.name.split(/\s+/)[0].replace(/\s+/g, "");
    const before = text.slice(0, caret).replace(/@([\w.]*)$/, "@" + token + " ");
    const next = before + text.slice(caret);
    setText(next); setMq(null);
    setTimeout(() => { el?.focus(); const p = before.length; el?.setSelectionRange(p, p); }, 0);
  };
  const mqMatches = mq !== null ? pool.filter((a) => a.name.toLowerCase().includes(mq) || a.email.toLowerCase().includes(mq)).slice(0, 6) : [];
  // When the @-typeahead is open, ↑/↓ move the highlight and Enter/Tab picks it (no newline / no submit).
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mq === null || !mqMatches.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setMqIdx((i) => (i + 1) % mqMatches.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setMqIdx((i) => (i - 1 + mqMatches.length) % mqMatches.length); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mqMatches[Math.min(mqIdx, mqMatches.length - 1)]); }
    else if (e.key === "Escape") { e.preventDefault(); setMq(null); }
  };

  const post = async () => {
    if (!text.trim() && !mentionEmails.length && !atts.length) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/feedback/${requestId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: text, mentions: mentionEmails, attachments: atts }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setText(""); setTags([]); setAtts([]); setMq(null);
      await load();
      onPosted();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ marginTop: 8, borderTop: "1px solid var(--line,#eee6d6)", paddingTop: 10 }}>
      {err && <div style={{ color: "#a83265", fontSize: 12.5, marginBottom: 6 }}>{err}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        {(comments || []).map((c) => {
          const nm = c.author_name || c.author_email || "Someone";
          return (
            <div key={c.id} style={{ display: "flex", gap: 9 }}>
              <span style={{ flex: "0 0 auto", width: 26, height: 26, borderRadius: "50%", background: avatarHue(c.author_email || nm), color: "#fff", fontSize: 11, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials(nm)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, color: "var(--muted,#8a94a0)" }}>
                  <span style={{ fontWeight: 700, color: "var(--navy,#254254)" }}>{nm}</span> · {whenFull(c.created_at)}
                </div>
                {c.body && <div style={{ fontSize: 13.5, color: "var(--navy-2,#4a5b66)", whiteSpace: "pre-wrap", marginTop: 1 }}>{c.body}</div>}
                {(c.attachments || []).length > 0 && (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
                    {(c.attachments || []).map((a) => (
                      <a key={a.url} href={a.url} target="_blank" rel="noopener" title={a.name}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={a.url} alt={a.name} style={{ width: 84, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)" }} />
                      </a>
                    ))}
                  </div>
                )}
                {(c.mentions || []).length > 0 && (
                  <div style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)", marginTop: 2 }}>Tagged: {(c.mentions || []).map((m) => nameFor(m)).join(", ")}</div>
                )}
              </div>
            </div>
          );
        })}
        {comments && !comments.length && <div className="muted" style={{ fontSize: 12.5 }}>No comments yet — start the conversation.</div>}
        {comments === null && !err && <div className="muted" style={{ fontSize: 12.5 }}>Loading…</div>}
      </div>

      <div
        style={{ marginTop: 10, position: "relative" }}
        onPaste={(e) => { const files = Array.from(e.clipboardData?.files || []); if (files.length) { e.preventDefault(); addFiles(files); } }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { if (e.dataTransfer?.files?.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } }}
      >
        <textarea ref={taRef} style={{ ...input, minHeight: 54, resize: "vertical" }} value={text}
          onChange={(e) => onTextChange(e.target.value)} onKeyDown={onKeyDown} placeholder="Add a comment or question… (type @ to tag someone; paste or drop a screenshot)" />
        {mq !== null && mqMatches.length > 0 && (
          <div style={{ position: "absolute", zIndex: 20, background: "var(--paper,#fff)", border: "1px solid var(--line,#e3ddcf)", borderRadius: 8, boxShadow: "0 6px 20px rgba(0,0,0,.12)", marginTop: 2, minWidth: 200, overflow: "hidden" }}>
            {mqMatches.map((a, i) => (
              <button key={a.email} onMouseEnter={() => setMqIdx(i)} onMouseDown={(e) => { e.preventDefault(); pickMention(a); }}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "7px 11px", border: "none", background: i === mqIdx ? "var(--paper-2,#f4f1ea)" : "transparent", cursor: "pointer", fontSize: 13 }}>
                <span style={{ width: 22, height: 22, borderRadius: "50%", background: avatarHue(a.email), color: "#fff", fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{initials(a.name)}</span>
                {a.name}
              </button>
            ))}
          </div>
        )}
        {atts.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
            {atts.map((a, i) => (
              <span key={a.url} style={{ position: "relative", display: "inline-block" }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.url} alt={a.name} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)" }} />
                <button onClick={() => setAtts((s) => s.filter((_, j) => j !== i))} aria-label="Remove"
                  style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "none", background: "var(--navy,#254254)", color: "#fff", cursor: "pointer", fontSize: 12, lineHeight: 1 }}>×</button>
              </span>
            ))}
          </div>
        )}
        {pool.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 8 }}>
            <span style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)" }}>Tag:</span>
            {pool.map((a) => {
              const on = mentionEmails.includes(a.email);
              return (
                <button key={a.email} onClick={() => toggleTag(a.email)}
                  style={{ ...chip, padding: "3px 9px", fontSize: 12, ...(on ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }}>
                  {on ? "✓ " : "@"}{a.name}
                </button>
              );
            })}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
          <label style={{ ...chip, padding: "4px 10px", fontSize: 12.5, cursor: "pointer" }}>
            📎 Image
            <input type="file" accept="image/*" multiple hidden onChange={(e) => { addFiles(e.target.files); e.currentTarget.value = ""; }} />
          </label>
          <button style={{ ...btnPrimary, padding: "6px 14px", fontSize: 13 }} disabled={busy || uploading || (!text.trim() && !mentionEmails.length && !atts.length)} onClick={post}>{busy ? "Posting…" : "Post"}</button>
          <span style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)" }}>{uploading ? "Uploading…" : mentionEmails.length ? `${mentionEmails.length} will be notified` : ""}</span>
        </div>
      </div>
    </div>
  );
}
