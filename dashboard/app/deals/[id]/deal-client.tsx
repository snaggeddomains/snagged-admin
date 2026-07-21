"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STATUSES, PRIORITIES, SOURCES } from "@/lib/deals/stages";

type Deal = {
  id: string; domain: string; additional_domains: string | null; buyer_name: string | null; buyer_email: string | null;
  buyer_phone: string | null; org_name: string | null; budget_range: string | null; appraisal_value: number | null;
  asking_price: number | null; source: string | null; priority: string | null; owner_email: string | null;
  stage: string; status: string; lost_reason: string | null; report_link: string | null; likely_owner: string | null;
  owner_contact: string | null; reachability: string | null; notes: string | null; tags: string[] | null; created_at: string;
};
type Activity = { id: string; user_email: string | null; kind: string; body: string | null; meta: Record<string, unknown> | null; created_at: string };
type Email = { id: string; mailbox: string | null; subject: string | null; snippet: string | null; from_addr: string | null; msg_date: string | null };
type Resp = { ok: boolean; deal: Deal; activity: Activity[]; emails: Email[]; assignees: { email: string }[]; me: string; error?: string };

const card: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 16, background: "var(--paper,#fff)", marginBottom: 14 };
const lbl: CSSProperties = { display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "9px 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
const inp: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "";
const short = (e: string | null) => e ? e.split("@")[0] : "system";

export default function DealClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<Deal>>({});
  const [saving, setSaving] = useState(false);
  const [comment, setComment] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [ingesting, setIngesting] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
      setForm(j.deal);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // Immediate patch (stage / status / owner / priority) — refetch to pick up new activity.
  const patchNow = async (partial: Record<string, unknown>) => {
    setForm((f) => ({ ...f, ...partial }));
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(partial) });
      if (!res.ok) throw new Error();
      load();
    } catch { load(); }
  };

  const saveDetails = async () => {
    setSaving(true);
    const f = form;
    const payload = {
      domain: f.domain, additional_domains: f.additional_domains, buyer_name: f.buyer_name, buyer_email: f.buyer_email,
      buyer_phone: f.buyer_phone, org_name: f.org_name, budget_range: f.budget_range,
      appraisal_value: f.appraisal_value === null || f.appraisal_value === undefined || (f.appraisal_value as unknown as string) === "" ? null : Number(f.appraisal_value),
      asking_price: f.asking_price === null || f.asking_price === undefined || (f.asking_price as unknown as string) === "" ? null : Number(f.asking_price),
      source: f.source, report_link: f.report_link, likely_owner: f.likely_owner, owner_contact: f.owner_contact,
      reachability: f.reachability, notes: f.notes,
      tags: typeof (f.tags as unknown) === "string" ? String(f.tags).split(",").map((t) => t.trim()).filter(Boolean) : f.tags,
    };
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  };

  const postComment = async () => {
    if (!comment.trim()) return;
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "comment", body: comment.trim(), mentions }) });
      if (!res.ok) throw new Error();
      setComment(""); setMentions([]); load();
    } catch { /* keep the text so it isn't lost */ }
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
  const d = data.deal;
  const f = form;
  const set = (k: keyof Deal, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  const tagsStr = Array.isArray(f.tags) ? f.tags.join(", ") : (f.tags || "");

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto" }}>
      <button style={{ ...btn, border: "none", padding: "4px 0", marginBottom: 8 }} onClick={() => router.push("/deals")}>← Board</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{d.domain}</h1>
        {d.report_link && <a href={d.report_link} target="_blank" rel="noreferrer" style={{ fontSize: 13, fontWeight: 600 }}>📄 Research report ↗</a>}
      </div>

      {/* Primary controls — immediate. */}
      <div style={{ ...card, display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
        <div><span style={lbl}>Stage</span><select style={inp} value={f.stage} onChange={(e) => patchNow({ stage: e.target.value })}>{STAGES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Status</span><select style={inp} value={f.status} onChange={(e) => patchNow({ status: e.target.value })}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
        <div><span style={lbl}>Owner</span><select style={inp} value={f.owner_email || ""} onChange={(e) => patchNow({ owner_email: e.target.value || null })}><option value="">Unassigned / Inbox</option>{data.assignees.map((a) => <option key={a.email} value={a.email}>{a.email}</option>)}</select></div>
        <div><span style={lbl}>Priority</span><select style={inp} value={f.priority || ""} onChange={(e) => patchNow({ priority: e.target.value || null })}><option value="">—</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select></div>
        {f.status === "lost" && <div style={{ flex: 1, minWidth: 180 }}><span style={lbl}>Lost reason</span><input style={inp} value={f.lost_reason || ""} onChange={(e) => set("lost_reason", e.target.value)} onBlur={() => patchNow({ lost_reason: f.lost_reason || null })} /></div>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        {/* Fields */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>Details</div>
          <span style={lbl}>Buyer name</span><input style={inp} value={f.buyer_name || ""} onChange={(e) => set("buyer_name", e.target.value)} />
          <span style={lbl}>Buyer email</span><input style={inp} value={f.buyer_email || ""} onChange={(e) => set("buyer_email", e.target.value)} />
          <span style={lbl}>Buyer phone</span><input style={inp} value={f.buyer_phone || ""} onChange={(e) => set("buyer_phone", e.target.value)} />
          <span style={lbl}>Company</span><input style={inp} value={f.org_name || ""} onChange={(e) => set("org_name", e.target.value)} />
          <span style={lbl}>Budget range</span><input style={inp} value={f.budget_range || ""} onChange={(e) => set("budget_range", e.target.value)} />
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
          <span style={lbl}>Notes</span><textarea style={{ ...inp, minHeight: 80, resize: "vertical" }} value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          <div style={{ marginTop: 12 }}><button style={btnPrimary} onClick={saveDetails} disabled={saving}>{saving ? "Saving…" : "Save details"}</button></div>
        </div>

        {/* Activity + comments + emails */}
        <div>
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Activity</div>
            <textarea style={{ ...inp, minHeight: 56, resize: "vertical" }} placeholder="Add a comment or note…" value={comment} onChange={(e) => setComment(e.target.value)} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, margin: "6px 0" }}>
              {data.assignees.filter((a) => a.email !== data.me).map((a) => {
                const on = mentions.includes(a.email);
                return <button key={a.email} onClick={() => setMentions((m) => on ? m.filter((x) => x !== a.email) : [...m, a.email])}
                  style={{ ...btn, padding: "2px 8px", fontSize: 11.5, background: on ? "var(--coral,#e2674a)" : "transparent", color: on ? "#fff" : "var(--navy-2,#4a5b66)", borderColor: on ? "var(--coral,#e2674a)" : "var(--line,#e3ddcf)" }}>@{short(a.email)}</button>;
              })}
            </div>
            <button style={btnPrimary} onClick={postComment} disabled={!comment.trim()}>Post{mentions.length ? ` · notify ${mentions.length}` : ""}</button>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
              {[...data.activity].reverse().map((a) => (
                <div key={a.id} style={{ fontSize: 12.5, borderLeft: "2px solid var(--line,#e6e0d3)", paddingLeft: 9 }}>
                  <div style={{ color: "var(--muted,#889)", fontSize: 11 }}>{short(a.user_email)} · {when(a.created_at)}</div>
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
            {data.emails.map((m) => (
              <div key={m.id} style={{ fontSize: 12.5, padding: "7px 0", borderTop: "1px solid var(--line,#eee)" }}>
                <div style={{ fontWeight: 600, color: "var(--navy,#254254)" }}>{m.subject || "(no subject)"}</div>
                <div style={{ color: "var(--muted,#889)", fontSize: 11 }}>{m.from_addr} · {when(m.msg_date)}{m.mailbox ? ` · ${m.mailbox}` : ""}</div>
                {m.snippet && <div style={{ color: "var(--navy-2,#4a5b66)", marginTop: 2 }}>{m.snippet}</div>}
              </div>
            ))}
            {!data.emails.length && <div className="muted" style={{ fontSize: 12 }}>No emails ingested yet. Click “Pull emails” to search the deal mailboxes for this buyer / domain.</div>}
          </div>
        </div>
      </div>
    </main>
  );
}

function activityText(a: Activity): string {
  const m = (a.meta || {}) as { from?: string; to?: string; mentions?: string[] };
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
