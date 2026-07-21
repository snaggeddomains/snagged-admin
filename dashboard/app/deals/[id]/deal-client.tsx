"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STATUSES, PRIORITIES, SOURCES, BUDGET_BANDS } from "@/lib/deals/stages";

type Deal = {
  id: string; domain: string; additional_domains: string | null; buyer_name: string | null; buyer_email: string | null;
  buyer_phone: string | null; org_name: string | null; budget_range: string | null; appraisal_value: number | null;
  asking_price: number | null; source: string | null; priority: string | null; owner_email: string | null;
  stage: string; status: string; lost_reason: string | null; report_link: string | null; likely_owner: string | null;
  owner_contact: string | null; reachability: string | null; notes: string | null; tags: string[] | null; created_at: string;
};
type Activity = { id: string; user_email: string | null; kind: string; body: string | null; meta: Record<string, unknown> | null; created_at: string };
type Email = { id: string; mailbox: string | null; subject: string | null; snippet: string | null; from_addr: string | null; msg_date: string | null };
type Assignee = { email: string; name: string };
type Resp = { ok: boolean; deal: Deal; activity: Activity[]; emails: Email[]; assignees: Assignee[]; me: string; error?: string };

const card: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 16, background: "var(--paper,#fff)", marginBottom: 14 };
const lbl: CSSProperties = { display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "9px 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
const inp: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const readVal: CSSProperties = { fontSize: 14, color: "var(--navy,#254254)", padding: "1px 0 2px" };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "";
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);
const OWNER_PALETTE = ["#2f6f7a", "#6b4a8a", "#2f7d4f", "#c0492f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a", "#8a5a2b", "#4a5b66"];
function ownerColor(email: string | null): string { if (!email) return "#b7bcc2"; let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0; return OWNER_PALETTE[h % OWNER_PALETTE.length]; }

export default function DealClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Partial<Deal>>({});
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [mq, setMq] = useState<string | null>(null); // active @mention query
  const [ingesting, setIngesting] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j); setForm(j.deal);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const nameFor = useCallback((email: string | null) => {
    if (!email) return "Inbox";
    return (data?.assignees || []).find((a) => a.email.toLowerCase() === email.toLowerCase())?.name || email;
  }, [data]);

  const save = async () => {
    setSaving(true);
    const f = form;
    const money = (v: unknown) => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    const payload = {
      stage: f.stage, status: f.status, owner_email: f.owner_email || null, priority: f.priority || null, lost_reason: f.lost_reason,
      buyer_name: f.buyer_name, buyer_email: f.buyer_email, buyer_phone: f.buyer_phone, org_name: f.org_name,
      budget_range: f.budget_range || null, appraisal_value: money(f.appraisal_value), asking_price: money(f.asking_price),
      source: f.source || null, additional_domains: f.additional_domains, report_link: f.report_link,
      likely_owner: f.likely_owner, owner_contact: f.owner_contact, reachability: f.reachability,
      tags: typeof (f.tags as unknown) === "string" ? String(f.tags).split(",").map((t) => t.trim()).filter(Boolean) : f.tags,
    };
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      await load(); setEditing(false);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  };

  // Resolve @tokens in the note to assignee emails (matches first name / squished full name / handle).
  const resolveMentions = (text: string): string[] => {
    const tokens = [...text.matchAll(/@(\w+)/g)].map((m) => m[1].toLowerCase());
    if (!tokens.length) return [];
    const out = new Set<string>();
    for (const a of data?.assignees || []) {
      const first = a.name.split(/\s+/)[0].toLowerCase();
      const full = a.name.toLowerCase().replace(/\s+/g, "");
      const handle = a.email.split("@")[0].toLowerCase();
      if (tokens.some((t) => t === first || t === full || t === handle)) out.add(a.email);
    }
    return [...out];
  };

  const onNoteChange = (v: string) => {
    setNote(v);
    const caret = taRef.current?.selectionStart ?? v.length;
    const m = v.slice(0, caret).match(/@(\w*)$/);
    setMq(m ? m[1].toLowerCase() : null);
  };
  const pickMention = (a: Assignee) => {
    const el = taRef.current; const caret = el?.selectionStart ?? note.length;
    const before = note.slice(0, caret).replace(/@(\w*)$/, "@" + a.name.split(/\s+/)[0].replace(/\s+/g, "") + " ");
    const next = before + note.slice(caret);
    setNote(next); setMq(null);
    setTimeout(() => { el?.focus(); const p = before.length; el?.setSelectionRange(p, p); }, 0);
  };
  const postNote = async () => {
    if (!note.trim()) return;
    const mentions = resolveMentions(note);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", body: note.trim(), mentions }) });
      if (!res.ok) throw new Error();
      setNote(""); setMq(null); load();
    } catch { /* keep the text */ }
  };

  const pullEmails = async () => {
    setIngesting(true);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ingest" }) });
      if (res.ok) { const j = await res.json(); setData((d) => d ? { ...d, emails: j.emails || d.emails } : d); }
    } finally { setIngesting(false); }
  };

  if (err && !data) return <main><p style={{ color: "#a83265" }}>Couldn&apos;t load the deal: {err}</p></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;
  const d = data.deal, f = form;
  const set = (k: keyof Deal, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  const tagsStr = Array.isArray(f.tags) ? f.tags.join(", ") : (f.tags || "");
  const oc = ownerColor(d.owner_email);
  const mentionMatches = mq != null ? (data.assignees.filter((a) => a.name.toLowerCase().includes(mq) || a.email.toLowerCase().includes(mq)).slice(0, 6)) : [];

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto" }}>
      <button style={{ ...btn, border: "none", padding: "4px 0", marginBottom: 8 }} onClick={() => router.push("/deals")}>← Board</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{d.domain}</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {d.report_link && <a href={d.report_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>📄 Research report ↗</a>}
          {!editing
            ? <button style={btn} onClick={() => { setForm(d); setEditing(true); }}>✎ Edit</button>
            : <><button style={btn} onClick={() => { setForm(d); setEditing(false); }} disabled={saving}>Cancel</button><button style={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button></>}
        </div>
      </div>

      {/* Stage / Status / Owner / Priority — locked by default; the Edit toggle unlocks. */}
      <div style={{ ...card, display: "flex", gap: 22, flexWrap: "wrap", marginTop: 12 }}>
        {!editing ? <>
          <div><span style={lbl}>Stage</span><div style={readVal}>{d.stage}</div></div>
          <div><span style={lbl}>Status</span><div style={{ ...readVal, fontWeight: 700, color: d.status === "won" ? "#1f7a5a" : d.status === "lost" ? "#a83265" : "inherit" }}>{d.status}</div></div>
          <div><span style={lbl}>Owner</span><div style={{ ...readVal, color: oc, fontWeight: 700 }}>● {nameFor(d.owner_email)}</div></div>
          <div><span style={lbl}>Priority</span><div style={readVal}>{d.priority || "—"}</div></div>
        </> : <>
          <div><span style={lbl}>Stage</span><select style={inp} value={f.stage} onChange={(e) => set("stage", e.target.value)}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><span style={lbl}>Status</span><select style={inp} value={f.status} onChange={(e) => set("status", e.target.value)}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
          <div><span style={lbl}>Owner</span><select style={inp} value={f.owner_email || ""} onChange={(e) => set("owner_email", e.target.value || null)}><option value="">Unassigned / Inbox</option>{data.assignees.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}</select></div>
          <div><span style={lbl}>Priority</span><select style={inp} value={f.priority || ""} onChange={(e) => set("priority", e.target.value || null)}><option value="">—</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
          {f.status === "lost" && <div style={{ flex: 1, minWidth: 180 }}><span style={lbl}>Lost reason</span><input style={inp} value={f.lost_reason || ""} onChange={(e) => set("lost_reason", e.target.value)} /></div>}
        </>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Details — read-first. */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Details</div>
          {!editing ? <>
            <RVal l="Buyer name" v={d.buyer_name} />
            <RVal l="Buyer email" v={d.buyer_email} />
            <RVal l="Buyer phone" v={d.buyer_phone} />
            <RVal l="Company" v={d.org_name} />
            <RVal l="Budget range" v={d.budget_range} />
            <div style={{ display: "flex", gap: 24 }}><RVal l="Appraisal $" v={d.appraisal_value != null ? usd(d.appraisal_value) : null} /><RVal l="Asking $" v={d.asking_price != null ? usd(d.asking_price) : null} /></div>
            <RVal l="Source" v={d.source} />
            <RVal l="Additional domains" v={d.additional_domains} />
            <RVal l="Research report link" v={d.report_link} link />
            <RVal l="Likely owner" v={d.likely_owner} />
            <RVal l="Owner contact" v={d.owner_contact} />
            <RVal l="Tags" v={(d.tags || []).join(", ") || null} />
            <RVal l="Notes" v={d.notes} />
          </> : <>
            <span style={lbl}>Buyer name</span><input style={inp} value={f.buyer_name || ""} onChange={(e) => set("buyer_name", e.target.value)} />
            <span style={lbl}>Buyer email</span><input style={inp} value={f.buyer_email || ""} onChange={(e) => set("buyer_email", e.target.value)} />
            <span style={lbl}>Buyer phone</span><input style={inp} value={f.buyer_phone || ""} onChange={(e) => set("buyer_phone", e.target.value)} />
            <span style={lbl}>Company</span><input style={inp} value={f.org_name || ""} onChange={(e) => set("org_name", e.target.value)} />
            <span style={lbl}>Budget range</span><select style={inp} value={f.budget_range || ""} onChange={(e) => set("budget_range", e.target.value)}><option value="">—</option>{BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}</select>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><span style={lbl}>Appraisal $</span><input style={inp} value={f.appraisal_value ?? ""} onChange={(e) => set("appraisal_value", e.target.value)} /></div>
              <div style={{ flex: 1 }}><span style={lbl}>Asking $</span><input style={inp} value={f.asking_price ?? ""} onChange={(e) => set("asking_price", e.target.value)} /></div>
            </div>
            <span style={lbl}>Source</span><select style={inp} value={f.source || ""} onChange={(e) => set("source", e.target.value)}><option value="">—</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <span style={lbl}>Additional domains</span><input style={inp} value={f.additional_domains || ""} onChange={(e) => set("additional_domains", e.target.value)} />
            <span style={lbl}>Research report link</span><input style={inp} value={f.report_link || ""} onChange={(e) => set("report_link", e.target.value)} />
            <span style={lbl}>Likely owner</span><input style={inp} value={f.likely_owner || ""} onChange={(e) => set("likely_owner", e.target.value)} />
            <span style={lbl}>Owner contact</span><input style={inp} value={f.owner_contact || ""} onChange={(e) => set("owner_contact", e.target.value)} />
            <span style={lbl}>Tags (comma-separated)</span><input style={inp} value={tagsStr} onChange={(e) => set("tags", e.target.value)} />
            <span style={lbl}>Notes</span><textarea style={{ ...inp, minHeight: 70, resize: "vertical" }} value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </>}
        </div>

        {/* Activity + notes (@mention type-ahead) + emails. */}
        <div>
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Activity</div>
            <div style={{ position: "relative" }}>
              <textarea ref={taRef} style={{ ...inp, minHeight: 60, resize: "vertical" }} placeholder="Add a note… type @ to mention someone" value={note}
                onChange={(e) => onNoteChange(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && mentionMatches.length && mq) { e.preventDefault(); pickMention(mentionMatches[0]); } }} />
              {mq != null && mentionMatches.length > 0 && (
                <div style={{ position: "absolute", zIndex: 20, left: 6, right: 6, background: "#fff", border: "1px solid var(--line,#e3ddcf)", borderRadius: 8, boxShadow: "0 4px 14px rgba(0,0,0,0.12)", overflow: "hidden" }}>
                  {mentionMatches.map((a) => (
                    <div key={a.email} onMouseDown={(e) => { e.preventDefault(); pickMention(a); }} style={{ padding: "7px 10px", fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: ownerColor(a.email), display: "inline-block" }} />{a.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div style={{ marginTop: 8 }}><button style={btnPrimary} onClick={postNote} disabled={!note.trim()}>Post note</button></div>
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
              {[...data.activity].reverse().map((a) => (
                <div key={a.id} style={{ fontSize: 12.5, borderLeft: "2px solid var(--line,#e6e0d3)", paddingLeft: 9 }}>
                  <div style={{ color: "var(--muted,#889)", fontSize: 11 }}>{nameFor(a.user_email) || "system"} · {when(a.created_at)}</div>
                  <div style={{ color: "var(--navy,#254254)", marginTop: 1 }}>{activityText(a)}</div>
                </div>
              ))}
              {!data.activity.length && <div className="muted" style={{ fontSize: 12 }}>No activity yet.</div>}
            </div>
          </div>

          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>📥 Emails ({data.emails.length})</span>
              <button style={btn} onClick={pullEmails} disabled={ingesting}>{ingesting ? "Pulling…" : "↻ Pull emails"}</button>
            </div>
            {data.emails.map((m) => <EmailRow key={m.id} m={m} />)}
            {!data.emails.length && <div className="muted" style={{ fontSize: 12 }}>No emails yet. They&apos;re pulled automatically each hour; “Pull emails” fetches now.</div>}
          </div>
        </div>
      </div>
    </main>
  );
}

function RVal({ l, v, link }: { l: string; v: string | null | undefined; link?: boolean }) {
  return (
    <div style={{ marginTop: 8 }}>
      <span style={lbl}>{l}</span>
      {v ? (link ? <a href={v} target="_blank" rel="noreferrer" style={{ ...readVal, wordBreak: "break-all" }}>{v}</a> : <div style={{ ...readVal, whiteSpace: "pre-wrap" }}>{v}</div>) : <div style={{ ...readVal, color: "var(--muted,#aab)" }}>—</div>}
    </div>
  );
}

// Pipedrive-style email row: envelope, subject, from→to, relative time, snippet, expandable body.
function EmailRow({ m }: { m: Email }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: "flex", gap: 9, padding: "9px 0", borderTop: "1px solid var(--line,#eee)" }}>
      <div style={{ flex: "none", width: 24, height: 24, borderRadius: "50%", background: "#eef2f4", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>✉</div>
      <div style={{ minWidth: 0, flex: 1, cursor: "pointer" }} onClick={() => setOpen((o) => !o)}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 13, color: "var(--navy,#254254)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.subject || "(no subject)"}</span>
          <span style={{ fontSize: 11, color: "var(--muted,#889)", flex: "none" }}>{when(m.msg_date)}</span>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted,#889)", marginTop: 1 }}>{m.from_addr}{m.mailbox ? ` → ${m.mailbox}` : ""}</div>
        {m.snippet && <div style={{ fontSize: 12.5, color: "var(--navy-2,#4a5b66)", marginTop: 3, ...(open ? {} : { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }) }}>{m.snippet}</div>}
      </div>
    </div>
  );
}

function activityText(a: Activity): string {
  const m = (a.meta || {}) as { from?: string; to?: string };
  switch (a.kind) {
    case "created": return a.body || "Deal created";
    case "stage_change": return `Moved: ${m.from} → ${m.to}`;
    case "status_change": return `Status: ${m.from} → ${m.to}${a.body ? ` (${a.body})` : ""}`;
    case "assignment": return `Assigned: ${m.to || "Inbox"}`;
    case "comment": return `💬 ${a.body}`;
    case "note": return `📝 ${a.body}`;
    case "email": return `📥 ${a.body || "Email ingested"}`;
    default: return a.body || a.kind;
  }
}
