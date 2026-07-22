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
  lead_key: string | null;
};
type Activity = { id: string; user_email: string | null; kind: string; body: string | null; meta: Record<string, unknown> | null; created_at: string };
type Email = { id: string; mailbox: string | null; subject: string | null; snippet: string | null; body: string | null; from_addr: string | null; msg_date: string | null };
type Assignee = { email: string; name: string };
type Resp = { ok: boolean; deal: Deal; dossierUrl: string | null; activity: Activity[]; emails: Email[]; assignees: Assignee[]; me: string; error?: string };

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
  const [wonOpen, setWonOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Close Won — confirm owner/contact + price/commission + recap, set won, log the recap.
  const closeWon = async (f: WonForm) => {
    const id = data?.deal.id;
    if (!id) return;
    const patch: Record<string, unknown> = { status: "won" };
    if (f.ownerName.trim()) patch.likely_owner = f.ownerName.trim();
    if (f.ownerContact.trim()) patch.owner_contact = f.ownerContact.trim();
    const price = Number(String(f.pricePaid).replace(/[^0-9.]/g, ""));
    const comm = Number(String(f.commission).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(price) && price > 0) patch.sale_price = price;
    if (Number.isFinite(comm) && comm > 0) patch.commission = comm;
    setWonOpen(false);
    await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    const lines = ["🏆 Closed WON",
      f.ownerName.trim() && `Owner: ${f.ownerName.trim()}`,
      f.ownerContact.trim() && `Owner contact: ${f.ownerContact.trim()}`,
      Number.isFinite(price) && price > 0 && `Price paid: $${price.toLocaleString()}`,
      Number.isFinite(comm) && comm > 0 && `Commission: $${comm.toLocaleString()}`,
      f.recap.trim() && `\n${f.recap.trim()}`,
    ].filter(Boolean).join("\n");
    await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "comment", body: lines, mentions: [] }) });
    await load();
  };

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
      domain: (f.domain || "").trim().toLowerCase(),
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
          {!editing && d.status === "open" && d.stage === STAGES[STAGES.length - 1] && <button style={{ ...btn, color: "#1f7a5a", borderColor: "#1f7a5a" }} onClick={() => setWonOpen(true)}>✓ Close won</button>}
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

      {/* Two columns on desktop, stacks to one on mobile (auto-fit collapses below ~660px). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
        {/* Details — read-first. */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Details</div>
          {!editing ? <>
            {/* Buyer name doubles as the lead-dossier link (👤) when the deal came from an inquiry. */}
            <RVal l="Buyer name" v={d.buyer_name || (data.dossierUrl ? "Lead dossier ↗" : null)} href={data.dossierUrl || undefined} emoji={data.dossierUrl ? "👤" : undefined} />
            <RVal l="Buyer email" v={d.buyer_email} />
            <RVal l="Buyer phone" v={d.buyer_phone} />
            <RVal l="Company" v={d.org_name} />
            <RVal l="Budget range" v={d.budget_range} />
            <div style={{ display: "flex", gap: 24 }}><RVal l="Appraisal $" v={d.appraisal_value != null ? usd(d.appraisal_value) : null} /><RVal l="Asking $" v={d.asking_price != null ? usd(d.asking_price) : null} /></div>
            <RVal l="Source" v={d.source} />
            <RVal l="Additional domains" v={d.additional_domains} />
            {/* Compact research-report link — replaces the long raw URL. */}
            <RVal l="Research report" v={d.report_link ? "Open report ↗" : null} href={d.report_link || undefined} emoji="📄" />
            <RVal l="Likely owner" v={d.likely_owner} />
            <RVal l="Owner contact" v={d.owner_contact} />
            <RVal l="Tags" v={(d.tags || []).join(", ") || null} />
            <RVal l="Notes" v={d.notes} />
          </> : <>
            <span style={lbl}>Target domain</span><input style={inp} value={f.domain || ""} onChange={(e) => set("domain", e.target.value)} placeholder="example.com" />
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

        {/* Email chain first (the deal's correspondence), then internal activity/notes. */}
        <div>
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>📥 Emails ({data.emails.length})</span>
              <button style={btn} onClick={pullEmails} disabled={ingesting}>{ingesting ? "Pulling…" : "↻ Pull emails"}</button>
            </div>
            {data.emails.map((m) => <EmailRow key={m.id} m={m} />)}
            {!data.emails.length && <div className="muted" style={{ fontSize: 12 }}>No emails yet. They&apos;re pulled automatically each hour; “Pull emails” fetches now.</div>}
          </div>

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
        </div>
      </div>
      {wonOpen && <WonModal deal={d} onClose={() => setWonOpen(false)} onSubmit={closeWon} />}
    </main>
  );
}

type WonForm = { ownerName: string; ownerContact: string; pricePaid: string; commission: string; recap: string };

// Confirm-before-Won: prefilled from the deal's researched owner + asking price; captures
// the final price paid, commission, and a recap before the deal is marked won.
function WonModal({ deal, onClose, onSubmit }: { deal: Deal; onClose: () => void; onSubmit: (f: WonForm) => void }) {
  const [f, setF] = useState<WonForm>({
    ownerName: deal.likely_owner || "",
    ownerContact: deal.owner_contact || "",
    pricePaid: deal.asking_price != null ? String(deal.asking_price) : "",
    commission: "",
    recap: "",
  });
  const set = (k: keyof WonForm, v: string) => setF((s) => ({ ...s, [k]: v }));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(440px,100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 2px" }}>🏆 Close deal — Won</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>Confirm the details before marking this deal won.</p>
        <label style={lbl}>Owner name</label>
        <input style={inp} value={f.ownerName} onChange={(e) => set("ownerName", e.target.value)} placeholder="Who we bought from" />
        <label style={lbl}>Owner contact</label>
        <input style={inp} value={f.ownerContact} onChange={(e) => set("ownerContact", e.target.value)} placeholder="Email / phone" />
        <label style={lbl}>Price paid</label>
        <input style={inp} value={f.pricePaid} onChange={(e) => set("pricePaid", e.target.value)} placeholder="$" inputMode="decimal" />
        <label style={lbl}>Commission</label>
        <input style={inp} value={f.commission} onChange={(e) => set("commission", e.target.value)} placeholder="$" inputMode="decimal" />
        <label style={lbl}>Recap / deal notes</label>
        <textarea style={{ ...inp, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={f.recap} onChange={(e) => set("recap", e.target.value)} placeholder="How it closed, terms, next steps…" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, background: "#1f7a5a", borderColor: "#1f7a5a" }} onClick={() => onSubmit(f)}>✓ Mark Won</button>
        </div>
      </div>
    </div>
  );
}

function RVal({ l, v, href, emoji }: { l: string; v: string | null | undefined; href?: string | null; emoji?: string }) {
  const prefix = emoji ? `${emoji} ` : "";
  const body = (v == null || v === "")
    ? <div style={{ ...readVal, color: "var(--muted,#aab)" }}>—</div>
    : href
      ? <a href={href} target="_blank" rel="noreferrer" style={{ ...readVal, fontWeight: 600 }}>{prefix}{v}</a>
      : <div style={{ ...readVal, whiteSpace: "pre-wrap" }}>{prefix}{v}</div>;
  return (
    <div style={{ marginTop: 8 }}>
      <span style={lbl}>{l}</span>
      {body}
    </div>
  );
}

// Parse a raw From header ("Kara Egan <kara@x.com>" / "kara@x.com") into name + email.
function parseAddr(raw: string | null): { name: string; email: string } {
  const s = (raw || "").trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: s.split("@")[0] || s, email: s.toLowerCase() };
}
function initialsOf(name: string): string {
  const parts = name.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}
const AVATAR_HUES = ["#2f6f7a", "#c0492f", "#6b4a8a", "#2f7d4f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a"];
function hueFor(key: string): string {
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}
// "6 hours ago" / "2 days ago" — the relative stamp Pipedrive shows next to the date.
function relTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0 || !Number.isFinite(diff)) return "";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

// Pipedrive-style email card: sender avatar (initials) + direction, subject, a
// date · relative-time · from→to meta line, a truncated preview, and a chevron to
// expand the full message inline.
function EmailRow({ m }: { m: Email }) {
  const [open, setOpen] = useState(false);
  const from = parseAddr(m.from_addr);
  const outbound = /@snagged\.(com|co)$/i.test(from.email); // we sent it
  const hue = hueFor(from.email || from.name);
  const to = m.mailbox ? parseAddr(m.mailbox) : null;
  return (
    <div style={{ display: "flex", gap: 11, padding: 12, border: "1px solid var(--line,#e6e0d3)", borderRadius: 10, marginBottom: 8, background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
      {/* Sender avatar with a direction badge (↗ we sent · ↙ they sent). */}
      <div style={{ flex: "none", position: "relative" }}>
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: hue, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12.5, fontWeight: 700 }} title={from.email}>{initialsOf(from.name)}</div>
        <span title={outbound ? "Sent by us" : "Received"} style={{ position: "absolute", right: -3, bottom: -3, width: 16, height: 16, borderRadius: "50%", background: outbound ? "#2f7d4f" : "#3f4a8f", color: "#fff", fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", border: "1.5px solid #fff" }}>{outbound ? "↗" : "↙"}</span>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
          <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.subject || "(no subject)"}</span>
          <button onClick={() => setOpen((o) => !o)} title={open ? "Collapse" : "Expand full message"}
            style={{ flex: "none", background: "none", border: "none", cursor: "pointer", color: "var(--muted,#889)", fontSize: 14, padding: "0 2px", lineHeight: 1 }}>{open ? "▴" : "▾"}</button>
        </div>
        <div style={{ fontSize: 11.5, color: "var(--muted,#889)", marginTop: 2 }}>
          <span style={{ fontWeight: 600, color: "var(--navy-2,#4a5b66)" }}>{from.name}</span>
          {to && <> → {to.name}</>}
          {m.msg_date && <> · {when(m.msg_date)}{relTime(m.msg_date) && <span> ({relTime(m.msg_date)})</span>}</>}
        </div>
        <div onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer", marginTop: 5 }}>
          {open
            ? <div style={{ fontSize: 12.5, color: "var(--navy-2,#3f4d57)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 360, overflowY: "auto", lineHeight: 1.5, background: "var(--paper-2,#f7f5ef)", borderRadius: 8, padding: "8px 10px" }}>{m.body || m.snippet || "(no content)"}</div>
            : (m.snippet && <div style={{ fontSize: 12.5, color: "var(--navy-2,#4a5b66)", overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" as const }}>{m.snippet}</div>)}
        </div>
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
