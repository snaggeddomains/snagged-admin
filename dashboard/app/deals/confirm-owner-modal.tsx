"use client";

// Confirm-the-owner modal — fired when a deal moves to Negotiating (from the board drag or
// the deal-detail stage change). At Negotiating we're confident who truly owns the name, so
// we capture/confirm them into the owner directory: prefilled from the deal's researched
// "likely owner" + owner contact, with a typeahead to link an existing owner instead of
// creating a duplicate, plus a first negotiation note. POSTs action=confirm.

import { useEffect, useRef, useState, type CSSProperties } from "react";

const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const inp: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const L: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };

export type ConfirmOwnerSeed = {
  dealId: string;
  domain: string;
  likelyOwner?: string | null;
  ownerContact?: string | null;   // free text; we try to split emails/phones out of it
  company?: string | null;
  alreadyLinked?: boolean;         // already has an owner record → note it, still allow edit
};

// Pull email(s) and phone(s) out of a free-text "owner contact" string.
function splitContact(s: string | null | undefined): { emails: string; phones: string } {
  const t = String(s || "");
  const emails = [...t.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map((m) => m[0]);
  const phones = [...t.matchAll(/\+?\d[\d\s().-]{6,}\d/g)].map((m) => m[0].trim()).filter((p) => !emails.some((e) => e.includes(p)));
  return { emails: emails.join(", "), phones: phones.join(", ") };
}

export default function ConfirmOwnerModal({ seed, onClose, onDone }: { seed: ConfirmOwnerSeed; onClose: () => void; onDone: (owner: { id: string; name: string }) => void }) {
  const c = splitContact(seed.ownerContact);
  const [f, setF] = useState({ name: seed.likelyOwner || "", kind: "person", company: seed.company || "", emails: c.emails, phones: c.phones, note: "" });
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // Typeahead against the existing directory so we link rather than duplicate.
  const [hits, setHits] = useState<{ id: string; name: string; email: string | null; company: string | null }[]>([]);
  const [open, setOpen] = useState(false);
  const pickedRef = useRef(false);
  useEffect(() => {
    if (pickedRef.current) { pickedRef.current = false; return; }
    setOwnerId(null); // editing the name after a pick means it's no longer that exact record
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
  const pick = (h: { id: string; name: string; email: string | null; company: string | null }) => {
    pickedRef.current = true;
    setOwnerId(h.id);
    setF((s) => ({ ...s, name: h.name, company: h.company || s.company, emails: h.email && !s.emails ? h.email : s.emails }));
    setOpen(false); setHits([]);
  };

  const submit = async () => {
    if (!f.name.trim() && !ownerId) { setError("Owner name is required."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/deals/owners", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm", deal_id: seed.dealId, owner_id: ownerId,
          name: f.name, kind: f.kind, company: f.company, emails: f.emails, phones: f.phones, negotiation_append: f.note }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onDone({ id: j.owner.id, name: j.owner.name });
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); }
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1100, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(460px,100%)", maxHeight: "92vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 2px" }}>👤 Confirm the owner</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 4px" }}>
          {seed.domain} reached Negotiating — save who we&apos;re dealing with so it&apos;s in the owner directory for next time.
          {seed.alreadyLinked && <> This deal already has an owner record; confirming updates it.</>}
        </p>
        <label style={L}>Owner name *</label>
        <div style={{ position: "relative" }}>
          <input style={inp} value={f.name} autoComplete="off" onChange={(e) => set("name", e.target.value)}
            onFocus={() => { if (hits.length) setOpen(true); }} onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Person or company we're buying from" />
          {open && hits.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10, background: "var(--paper,#fff)", border: "1px solid var(--line,#e3ddcf)", borderRadius: 8, marginTop: 3, boxShadow: "0 6px 18px rgba(20,25,30,0.12)", maxHeight: 200, overflowY: "auto" }}>
              <div style={{ padding: "5px 10px", fontSize: 11, color: "var(--muted,#8a94a0)", borderBottom: "1px solid var(--line,#eee6d6)" }}>Existing owners — pick to link (avoids a duplicate)</div>
              {hits.map((h) => (
                <button key={h.id} type="button" onMouseDown={(e) => { e.preventDefault(); pick(h); }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: "transparent", border: "none", cursor: "pointer", fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>{h.name}</span>{(h.email || h.company) && <span style={{ color: "var(--muted,#8a94a0)" }}>{" · "}{[h.email, h.company].filter(Boolean).join(" · ")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {ownerId && <div style={{ fontSize: 11.5, color: "#1f7a5a", marginTop: 4 }}>✓ Linking to an existing owner record.</div>}
        <label style={L}>Type</label>
        <select style={inp} value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="person">Person</option><option value="company">Company</option><option value="unknown">Unknown</option></select>
        <label style={L}>Company</label>
        <input style={inp} value={f.company} onChange={(e) => set("company", e.target.value)} placeholder="Employer / org (if a person)" />
        <label style={L}>Emails <span style={{ fontWeight: 400, color: "var(--muted,#8a94a0)" }}>(comma-separated)</span></label>
        <input style={inp} value={f.emails} onChange={(e) => set("emails", e.target.value)} />
        <label style={L}>Phones <span style={{ fontWeight: 400, color: "var(--muted,#8a94a0)" }}>(comma-separated)</span></label>
        <input style={inp} value={f.phones} onChange={(e) => set("phones", e.target.value)} />
        <label style={L}>Negotiation note <span style={{ fontWeight: 400, color: "var(--muted,#8a94a0)" }}>(optional — how they&apos;re negotiating)</span></label>
        <textarea style={{ ...inp, minHeight: 60, resize: "vertical" }} value={f.note} onChange={(e) => set("note", e.target.value)} placeholder="e.g. Opened at $80k, seems motivated, prefers text." />
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 16 }}>
          <button style={{ ...btn, border: "none", color: "var(--muted,#8a94a0)" }} onClick={onClose} disabled={busy}>Skip for now</button>
          <button style={btnPrimary} onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save owner"}</button>
        </div>
      </div>
    </div>
  );
}
