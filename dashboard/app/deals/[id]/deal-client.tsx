"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ClipboardEvent as RClipboardEvent } from "react";
import { useRouter } from "next/navigation";
import { STAGES, STATUSES, PRIORITIES, SOURCES, BUDGET_BANDS } from "@/lib/deals/stages";
import ConfirmOwnerModal, { type ConfirmOwnerSeed } from "../confirm-owner-modal";

const NEGOTIATING = "Negotiating";

type Deal = {
  id: string; domain: string; additional_domains: string | null; buyer_name: string | null; buyer_email: string | null;
  buyer_phone: string | null; org_name: string | null; budget_range: string | null; appraisal_value: number | null;
  asking_price: number | null; current_offer: number | null; upfront_fee: number | null; upfront_paid: boolean | null; source: string | null; heard_about: string | null; priority: string | null; owner_email: string | null;
  stage: string; status: string; lost_reason: string | null; report_link: string | null; likely_owner: string | null;
  owner_contact: string | null; reachability: string | null; notes: string | null; tags: string[] | null; created_at: string;
  lead_key: string | null; domain_owner_id: string | null;
};
type Activity = { id: string; user_email: string | null; kind: string; body: string | null; meta: Record<string, unknown> | null; created_at: string };
type Email = { id: string; mailbox: string | null; subject: string | null; snippet: string | null; body: string | null; from_addr: string | null; msg_date: string | null };
type Assignee = { email: string; name: string };
type AddlDomain = { domain: string; report: string | null };
type OwnerRecord = { id: string; name: string };
type Reminder = { id: string; remind_at: string; note: string | null };
type Resp = { ok: boolean; deal: Deal; dossierUrl: string | null; ownerRecord?: OwnerRecord | null; additional?: AddlDomain[]; activity: Activity[]; emails: Email[]; assignees: Assignee[]; shares?: string[]; reminder?: Reminder | null; canEdit?: boolean; me: string; error?: string };

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
  const [emailsOpen, setEmailsOpen] = useState(false); // email chain collapsed by default (can be 47+)
  const [negSeed, setNegSeed] = useState<ConfirmOwnerSeed | null>(null); // confirm-owner on move to Negotiating
  const [pendingAtts, setPendingAtts] = useState<{ url: string; name: string; type: string }[]>([]); // images staged for the next comment
  const [uploading, setUploading] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Share a deal with a colleague (view + comment). Also happens implicitly on @mention.
  const shareWith = async (email: string) => {
    await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "share", emails: [email] }) });
    await load();
  };
  const unshare = async (email: string) => {
    await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unshare", email }) });
    await load();
  };
  // Boomerang — snooze the deal to revisit on a date (personal; surfaces in My Tasks when due).
  const snooze = async (remindAt: string, noteText: string) => {
    if (!remindAt) return;
    await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "snooze", remind_at: remindAt, note: noteText }) });
    setSnoozeOpen(false); await load();
  };
  const unsnooze = async () => {
    await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "unsnooze" }) });
    await load();
  };

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
  // Deep-link from a comment/@mention notification (…/deals/<id>#comments) → scroll to the thread.
  useEffect(() => {
    if (data && typeof window !== "undefined" && window.location.hash === "#comments") {
      setTimeout(() => document.getElementById("comments")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    }
  }, [data]);

  const nameFor = useCallback((email: string | null) => {
    if (!email) return "Inbox";
    return (data?.assignees || []).find((a) => a.email.toLowerCase() === email.toLowerCase())?.name || email;
  }, [data]);

  // Assign each distinct commenter a clearly-different color (by order of appearance), so it's
  // easy to tell who said what — avoids the hash-collision look where two people read the same.
  const commentColor = useMemo(() => {
    const map: Record<string, string> = {}; let n = 0;
    for (const a of data?.activity || []) {
      const e = (a.user_email || "").toLowerCase();
      if (!e || map[e]) continue;
      map[e] = OWNER_PALETTE[n % OWNER_PALETTE.length]; n += 1;
    }
    return (email: string | null) => map[(email || "").toLowerCase()] || ownerColor(email);
  }, [data]);

  const save = async () => {
    setSaving(true);
    const f = form;
    const money = (v: unknown) => { if (v === "" || v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    const payload = {
      domain: (f.domain || "").trim().toLowerCase(),
      stage: f.stage, status: f.status, owner_email: f.owner_email || null, priority: f.priority || null, lost_reason: f.lost_reason,
      buyer_name: f.buyer_name, buyer_email: f.buyer_email, buyer_phone: f.buyer_phone, org_name: f.org_name,
      budget_range: f.budget_range || null, appraisal_value: money(f.appraisal_value), asking_price: money(f.asking_price), current_offer: money(f.current_offer), upfront_fee: money(f.upfront_fee),
      source: f.source || null, heard_about: f.heard_about || null, additional_domains: f.additional_domains, report_link: f.report_link,
      likely_owner: f.likely_owner, owner_contact: f.owner_contact, reachability: f.reachability,
      tags: typeof (f.tags as unknown) === "string" ? String(f.tags).split(",").map((t) => t.trim()).filter(Boolean) : f.tags,
    };
    const before = data?.deal;
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      await load(); setEditing(false);
      // Moving to Negotiating = we're confident who owns it → confirm the owner into the directory.
      if (payload.stage === NEGOTIATING && before && before.stage !== NEGOTIATING && !before.domain_owner_id) {
        setNegSeed({ dealId: before.id, domain: before.domain, likelyOwner: before.likely_owner, ownerContact: before.owner_contact, company: before.org_name });
      }
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
  // Upload pasted/selected images → staged as pending attachments for the next comment.
  const uploadFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!imgs.length) return;
    setUploading(true); setErr(null);
    try {
      for (const f of imgs) {
        const fd = new FormData(); fd.append("file", f);
        const res = await fetch(`/api/admin/deals/${id}/upload`, { method: "POST", body: fd });
        const j = await res.json().catch(() => ({}));
        if (res.ok && j.attachment) setPendingAtts((a) => [...a, j.attachment]);
        else setErr(j.error || "Image upload failed");
      }
    } finally { setUploading(false); }
  };
  const onPaste = (e: RClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items || []).filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean) as File[];
    if (files.length) { e.preventDefault(); uploadFiles(files); }
  };
  const postNote = async () => {
    if (!note.trim() && !pendingAtts.length) return;
    const mentions = resolveMentions(note);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", body: note.trim(), mentions, attachments: pendingAtts }) });
      if (!res.ok) throw new Error();
      setNote(""); setMq(null); setPendingAtts([]); load();
    } catch { /* keep the text */ }
  };

  const pullEmails = async () => {
    setIngesting(true);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ingest" }) });
      if (res.ok) { const j = await res.json(); setData((d) => d ? { ...d, emails: j.emails || d.emails } : d); }
    } finally { setIngesting(false); }
  };

  // Re-pull likely owner / owner contact / appraisal from the (possibly re-run) research
  // report, OVERWRITING the sidebar — the auto-fill only fills empties, so a re-run whose
  // owner changed won't flow through on its own.
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);
  const resyncResearch = async () => {
    setResyncing(true); setResyncMsg(null);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resync-research" }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { setResyncMsg("Updated from research."); load(); }
      else setResyncMsg(j.error || "Couldn't re-sync.");
    } catch { setResyncMsg("Couldn't re-sync."); }
    finally { setResyncing(false); }
  };

  if (err && !data) return <main><p style={{ color: "#a83265" }}>Couldn&apos;t load the deal: {err}</p></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;
  const d = data.deal, f = form;
  const set = (k: keyof Deal, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  const tagsStr = Array.isArray(f.tags) ? f.tags.join(", ") : (f.tags || "");
  const oc = ownerColor(d.owner_email);
  const mentionMatches = mq != null ? (data.assignees.filter((a) => a.name.toLowerCase().includes(mq) || a.email.toLowerCase().includes(mq)).slice(0, 6)) : [];
  const canEdit = data.canEdit !== false;                 // a shared viewer can comment but not edit
  const shares = data.shares || [];
  const shareable = data.assignees.filter((a) => a.email.toLowerCase() !== (d.owner_email || "").toLowerCase() && !shares.includes(a.email.toLowerCase()));

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto" }}>
      <button style={{ ...btn, border: "none", padding: "4px 0", marginBottom: 8 }} onClick={() => router.push("/deals")}>← Board</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <h1 style={{ fontSize: "1.5rem", margin: 0 }}>{d.domain}</h1>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {!canEdit && <span style={{ fontSize: 12, fontWeight: 700, color: "#1f6b52", background: "#dff2ea", borderRadius: 999, padding: "3px 10px" }}>🔗 Shared with you · view &amp; comment</span>}
          {data.reminder
            ? <button style={{ ...btn, color: "#9a3412", borderColor: "#f0c9a8" }} onClick={unsnooze} title={`Boomerangs ${when(data.reminder.remind_at)}`}>⏰ Snoozed · clear</button>
            : <button style={btn} onClick={() => setSnoozeOpen((v) => !v)}>⏰ Snooze</button>}
          <button style={btn} onClick={() => setShareOpen((v) => !v)}>🤝 Share{shares.length ? ` (${shares.length})` : ""}</button>
          {canEdit && !editing && d.status === "open" && d.stage === STAGES[STAGES.length - 1] && <button style={{ ...btn, color: "#1f7a5a", borderColor: "#1f7a5a" }} onClick={() => setWonOpen(true)}>✓ Close won</button>}
          {canEdit && (!editing
            ? <button style={btn} onClick={() => { setForm(d); setEditing(true); }}>✎ Edit</button>
            : <><button style={btn} onClick={() => { setForm(d); setEditing(false); }} disabled={saving}>Cancel</button><button style={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button></>)}
        </div>
      </div>

      {/* Snooze / boomerang panel */}
      {snoozeOpen && !data.reminder && (
        <div style={{ ...card, marginTop: 10, marginBottom: 0, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <SnoozeForm onSet={snooze} onCancel={() => setSnoozeOpen(false)} />
        </div>
      )}

      {/* Share panel — who this deal is shared with + add a colleague. */}
      {shareOpen && (
        <div style={{ ...card, marginTop: 10, marginBottom: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Shared with</div>
          {shares.length === 0 && <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Not shared yet. Share a deal to let a colleague view it and join the comment thread (they can&apos;t edit). @mentioning someone in a comment shares it too.</div>}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {shares.map((email) => (
              <span key={email} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#eef4f2", borderRadius: 999, padding: "3px 6px 3px 10px", fontSize: 12.5 }}>
                <span style={{ color: ownerColor(email), fontWeight: 700 }}>●</span> {nameFor(email)}
                <button onClick={() => unshare(email)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94a3b8", fontSize: 14, lineHeight: 1 }}>✕</button>
              </span>
            ))}
          </div>
          {shareable.length > 0 && (
            <select style={{ ...inp, maxWidth: 280 }} value="" onChange={(e) => { if (e.target.value) shareWith(e.target.value); }}>
              <option value="">＋ Share with…</option>
              {shareable.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
            </select>
          )}
        </div>
      )}

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
            {/* At-a-glance price gap — latest client OFFER vs latest owner ASKING, side by side (Sam, 2026-08-07). */}
            <div style={{ display: "flex", gap: 24, alignItems: "flex-end" }}>
              <RVal l="Current offer $" v={d.current_offer != null ? usd(d.current_offer) : null} />
              <RVal l="Asking $" v={d.asking_price != null ? usd(d.asking_price) : null} />
              {d.current_offer != null && d.asking_price != null && d.asking_price - d.current_offer > 0 && (
                <span style={{ fontSize: 11, fontWeight: 700, color: "#946200", background: "#fdf0d2", padding: "2px 8px", borderRadius: 999, marginBottom: 2 }} title="Gap between the owner's asking price and our client's current offer">Δ {usd(d.asking_price - d.current_offer)}</span>
              )}
            </div>
            <RVal l="Appraisal $" v={d.appraisal_value != null ? usd(d.appraisal_value) : null} />
            {/* Upfront fee we charged the client — "Paid" flips automatically at Research & Outreach. */}
            <div style={{ marginTop: 8 }}>
              <span style={lbl}>Upfront fee</span>
              <div style={{ ...readVal, display: "flex", gap: 8, alignItems: "center" }}>
                <span>{d.upfront_fee != null ? usd(d.upfront_fee) : "—"}</span>
                {d.upfront_fee != null && (d.upfront_paid
                  ? <span style={{ fontSize: 11, fontWeight: 700, color: "#1f7a5a", background: "#e4f2ea", padding: "1px 8px", borderRadius: 999 }}>✓ Paid</span>
                  : <span style={{ fontSize: 11, fontWeight: 700, color: "#946200", background: "#fdf0d2", padding: "1px 8px", borderRadius: 999 }}>Unpaid</span>)}
              </div>
            </div>
            <RVal l="Source" v={d.source} />
            <RVal l="Heard about" v={d.heard_about} />
            {/* Each additional domain on its own line, with its own research report link. */}
            <div style={{ marginTop: 8 }}>
              <span style={lbl}>Additional domains</span>
              {data.additional && data.additional.length ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {data.additional.map((a) => (
                    <div key={a.domain} style={{ ...readVal, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <span>{a.domain}</span>
                      {a.report && <a href={a.report} style={{ fontSize: 12.5, fontWeight: 600 }}>📄 Open report ↗</a>}
                    </div>
                  ))}
                </div>
              ) : <div style={{ ...readVal, color: "var(--muted,#aab)" }}>—</div>}
            </div>
            {/* Compact research-report link — replaces the long raw URL. */}
            <RVal l="Research report" v={d.report_link ? "Open report ↗" : null} href={d.report_link || undefined} emoji="📄" />
            <RVal l="Likely owner" v={d.likely_owner} />
            <RVal l="Owner contact" v={d.owner_contact} />
            {/* Force the (possibly re-run) research report's owner/appraisal into the deal —
                the auto-fill only fills empties, so a changed owner won't flow through on its own. */}
            {d.report_link && (
              <div style={{ marginTop: 6 }}>
                <button style={{ ...btn, padding: "4px 10px", fontSize: 12 }} onClick={resyncResearch} disabled={resyncing}>
                  {resyncing ? "Re-syncing…" : "↻ Re-sync from research"}
                </button>
                {resyncMsg && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--muted,#7c8b95)" }}>{resyncMsg}</span>}
              </div>
            )}
            {/* Owner directory record — set at Negotiating; links to the owner's full dossier
                (contact info + every name we've worked with them + negotiation history). */}
            {data.ownerRecord
              ? <RVal l="Owner record" v={`${data.ownerRecord.name} ↗`} href={`/deals/owners/${data.ownerRecord.id}`} emoji="👤" />
              : (d.stage === NEGOTIATING && (
                <div style={{ marginTop: 8 }}>
                  <span style={lbl}>Owner record</span>
                  <div style={readVal}><button style={{ ...btn, padding: "4px 10px", fontSize: 12 }} onClick={() => setNegSeed({ dealId: d.id, domain: d.domain, likelyOwner: d.likely_owner, ownerContact: d.owner_contact, company: d.org_name })}>👤 Confirm owner</button></div>
                </div>
              ))}
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
              <div style={{ flex: 1 }}><span style={lbl}>Current offer $ <span style={{ fontWeight: 400, textTransform: "none", color: "var(--muted,#8a94a0)" }}>— latest client offer</span></span><input style={inp} value={f.current_offer ?? ""} onChange={(e) => set("current_offer", e.target.value)} inputMode="decimal" placeholder="$" /></div>
              <div style={{ flex: 1 }}><span style={lbl}>Asking $ <span style={{ fontWeight: 400, textTransform: "none", color: "var(--muted,#8a94a0)" }}>— latest owner asking</span></span><input style={inp} value={f.asking_price ?? ""} onChange={(e) => set("asking_price", e.target.value)} inputMode="decimal" placeholder="$" /></div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}><span style={lbl}>Appraisal $</span><input style={inp} value={f.appraisal_value ?? ""} onChange={(e) => set("appraisal_value", e.target.value)} inputMode="decimal" placeholder="$" /></div>
            </div>
            <span style={lbl}>Upfront fee $ <span style={{ fontWeight: 400, textTransform: "none", color: "var(--muted,#8a94a0)" }}>— what we charged the client to pursue it</span></span>
            <input style={inp} value={f.upfront_fee ?? ""} onChange={(e) => set("upfront_fee", e.target.value)} inputMode="decimal" placeholder="$" />
            <span style={lbl}>Source</span><select style={inp} value={f.source || ""} onChange={(e) => set("source", e.target.value)}><option value="">—</option>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
            <span style={lbl}>Heard about <span style={{ fontWeight: 400, textTransform: "none", color: "var(--muted,#8a94a0)" }}>— how did you hear about us?</span></span><input style={inp} value={f.heard_about || ""} onChange={(e) => set("heard_about", e.target.value)} placeholder="e.g. X / Twitter" />
            <span style={lbl}>Additional domains</span><input style={inp} value={f.additional_domains || ""} onChange={(e) => set("additional_domains", e.target.value)} />
            <span style={lbl}>Research report link</span><input style={inp} value={f.report_link || ""} onChange={(e) => set("report_link", e.target.value)} />
            <span style={lbl}>Likely owner</span><input style={inp} value={f.likely_owner || ""} onChange={(e) => set("likely_owner", e.target.value)} />
            <span style={lbl}>Owner contact</span><input style={inp} value={f.owner_contact || ""} onChange={(e) => set("owner_contact", e.target.value)} />
            <span style={lbl}>Tags (comma-separated)</span><input style={inp} value={tagsStr} onChange={(e) => set("tags", e.target.value)} />
            <span style={lbl}>Notes</span><textarea style={{ ...inp, minHeight: 70, resize: "vertical" }} value={f.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </>}
        </div>

        {/* Comments first (Asana-style threaded), then the collapsed email chain. */}
        <div>
          <div id="comments" style={{ ...card, scrollMarginTop: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 12 }}>💬 Comments</div>
            {/* Thread — chronological (oldest first), composer at the bottom like Asana. */}
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {(() => {
                const comments = data.activity
                  .filter((a) => a.kind === "comment" || a.kind === "note")
                  .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
                return comments.length ? comments.map((a) => {
                  const who = nameFor(a.user_email) || "system";
                  return (
                    <div key={a.id} style={{ display: "flex", gap: 10 }}>
                      <Avatar name={who} bg={commentColor(a.user_email)} />
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13 }}><span style={{ fontWeight: 700, color: commentColor(a.user_email) }}>{who}</span> <span style={{ color: "var(--muted,#8a94a0)" }}>· {relTime(a.created_at) || when(a.created_at)}</span></div>
                        {a.body && <div style={{ fontSize: 14, color: "var(--navy,#254254)", marginTop: 3, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{renderMentionBody(a.body)}</div>}
                        <CommentImages meta={a.meta} />
                      </div>
                    </div>
                  );
                }) : <div className="muted" style={{ fontSize: 12 }}>No comments yet.</div>;
              })()}
            </div>
            {/* Composer — supports @mentions + pasted / attached images */}
            <div style={{ position: "relative", marginTop: 14 }}
              onDragOver={(e) => { e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files); }}>
              <textarea ref={taRef} style={{ ...inp, minHeight: 60, resize: "vertical" }} placeholder="Add a comment… paste or drop an image · type @ to mention" value={note}
                onPaste={onPaste}
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
            {/* Staged image thumbnails (remove with ✕ before posting) */}
            {(pendingAtts.length > 0 || uploading) && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                {pendingAtts.map((a, i) => (
                  <div key={a.url} style={{ position: "relative" }}>
                    <img src={a.url} alt={a.name} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)" }} />
                    <button title="Remove" onClick={() => setPendingAtts((s) => s.filter((_, j) => j !== i))}
                      style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", border: "none", background: "#254254", color: "#fff", fontSize: 11, cursor: "pointer", lineHeight: 1 }}>✕</button>
                  </div>
                ))}
                {uploading && <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>Uploading…</span>}
              </div>
            )}
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ""; }} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button style={{ ...btn, padding: "5px 10px", fontSize: 12.5 }} onClick={() => fileRef.current?.click()} disabled={uploading}>📎 Image</button>
                <span className="muted" style={{ fontSize: 11 }}>{resolveMentions(note).length ? `${resolveMentions(note).length} will be notified` : ""}</span>
              </div>
              <button style={btnPrimary} onClick={postNote} disabled={uploading || (!note.trim() && !pendingAtts.length)}>Comment</button>
            </div>
          </div>

          {/* Emails — collapsed by default (can be 47+); expand to view the chain. */}
          <div style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: emailsOpen ? 8 : 0 }}>
              <button onClick={() => setEmailsOpen((v) => !v)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 800, fontSize: 14, color: "var(--navy,#254254)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11 }}>{emailsOpen ? "▾" : "▸"}</span> 📥 Emails ({data.emails.length})
              </button>
              {emailsOpen && <button style={btn} onClick={pullEmails} disabled={ingesting}>{ingesting ? "Pulling…" : "↻ Pull emails"}</button>}
            </div>
            {emailsOpen && <>
              {data.emails.map((m) => <EmailRow key={m.id} m={m} />)}
              {!data.emails.length && <div className="muted" style={{ fontSize: 12 }}>No emails yet. They&apos;re pulled automatically each hour; “Pull emails” fetches now.</div>}
            </>}
          </div>

          {/* Activity — the internal system log (created / stage / status / assignment), separate
              from the discussion Comments. Compact, muted, chronological. */}
          {(() => {
            const events = data.activity
              .filter((a) => a.kind !== "comment" && a.kind !== "note")
              .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
            if (!events.length) return null;
            return (
              <div style={card}>
                <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>Activity</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {events.map((a) => (
                    <div key={a.id} style={{ fontSize: 12, color: "var(--muted,#8a94a0)" }}>
                      <span style={{ fontWeight: 600 }}>{nameFor(a.user_email) || "system"}</span> {activityText(a)} · {relTime(a.created_at) || when(a.created_at)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
      {wonOpen && <WonModal deal={d} onClose={() => setWonOpen(false)} onSubmit={closeWon} />}
      {negSeed && <ConfirmOwnerModal seed={negSeed} onClose={() => setNegSeed(null)} onDone={() => { setNegSeed(null); load(); }} />}
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

// Render any image attachments stored on a comment's meta (opens full-size in a new tab).
function CommentImages({ meta }: { meta: Record<string, unknown> | null }) {
  const atts = (meta && Array.isArray((meta as { attachments?: unknown }).attachments) ? (meta as { attachments: { url: string; name?: string }[] }).attachments : []);
  if (!atts.length) return null;
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
      {atts.map((im) => (
        <a key={im.url} href={im.url} target="_blank" rel="noreferrer">
          <img src={im.url} alt={im.name || "image"} style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", display: "block" }} />
        </a>
      ))}
    </div>
  );
}

// Highlight @mentions (a capitalized name after @) as a chip, Asana-style.
function renderMentionBody(body: string) {
  return String(body || "").split(/(@[A-Z][A-Za-z]*(?:\s[A-Z][A-Za-z]*)?)/g).map((p, i) =>
    /^@[A-Z]/.test(p)
      ? <span key={i} style={{ color: "#2f6f7a", fontWeight: 700 }}>{p}</span>
      : <span key={i}>{p}</span>);
}
// Small circular initials avatar, like Asana's comment avatars. `bg` lets the thread assign
// each distinct commenter a clearly-different color (so it's easy to see who said what).
function Avatar({ name, bg, size = 28 }: { name: string; bg: string; size?: number }) {
  return (
    <span style={{ width: size, height: size, flex: `0 0 ${size}px`, borderRadius: "50%", background: bg, color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.4, fontWeight: 700 }}>
      {initialsOf(name)}
    </span>
  );
}

// Boomerang picker — a date (quick presets or a custom date) + optional reason.
function SnoozeForm({ onSet, onCancel }: { onSet: (remindAt: string, note: string) => void; onCancel: () => void }) {
  const [date, setDate] = useState("");
  const [note, setNote] = useState("");
  const preset = (days: number) => { const dt = new Date(); dt.setDate(dt.getDate() + days); dt.setHours(9, 0, 0, 0); return dt.toISOString(); };
  return (
    <>
      <div>
        <span style={lbl}>Revisit this deal</span>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button style={{ ...btn, padding: "5px 10px", fontSize: 12 }} onClick={() => onSet(preset(1), note)}>Tomorrow</button>
          <button style={{ ...btn, padding: "5px 10px", fontSize: 12 }} onClick={() => onSet(preset(3), note)}>In 3 days</button>
          <button style={{ ...btn, padding: "5px 10px", fontSize: 12 }} onClick={() => onSet(preset(7), note)}>In a week</button>
          <input type="date" style={{ ...inp, width: "auto" }} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <input style={{ ...inp, flex: "1 1 160px" }} placeholder="Why revisit? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <button style={btnPrimary} disabled={!date} onClick={() => date && onSet(new Date(`${date}T09:00:00`).toISOString(), note)}>Set</button>
      <button style={btn} onClick={onCancel}>Cancel</button>
    </>
  );
}

function RVal({ l, v, href, emoji }: { l: string; v: string | null | undefined; href?: string | null; emoji?: string }) {
  const prefix = emoji ? `${emoji} ` : "";
  // Internal app links (report / dossier) navigate in the SAME window — the desktop
  // app spawns a new window on target=_blank, which loses the session.
  const body = (v == null || v === "")
    ? <div style={{ ...readVal, color: "var(--muted,#aab)" }}>—</div>
    : href
      ? <a href={href} style={{ ...readVal, fontWeight: 600 }}>{prefix}{v}</a>
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
