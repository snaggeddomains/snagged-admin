"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

type Owner = {
  id: string; name: string; kind: string; company: string | null;
  emails: string[]; phones: string[]; links: string[]; reachability: string | null;
  notes: string | null; negotiation_notes: string | null; created_at: string; updated_at: string;
};
type OwnerDeal = { id: string; domain: string; stage: string; status: string; buyer_name: string | null; asking_price: number | null; sale_price: number | null; created_at: string; updated_at: string };
type Acquisition = { domain: string; date: string | null; price: string | null };
type Resp = { ok: boolean; owner: Owner; deals: OwnerDeal[]; acquisitions?: Acquisition[]; error?: string };

const card: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 16, background: "var(--paper,#fff)", marginBottom: 14 };
const lbl: CSSProperties = { display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "9px 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
const inp: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const btn: CSSProperties = { padding: "7px 13px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const readVal: CSSProperties = { fontSize: 14, color: "var(--navy,#254254)", padding: "1px 0 2px" };
const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString() : "";
const OWNER_HUES = ["#2f6f7a", "#c0492f", "#6b4a8a", "#2f7d4f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a"];
const hueFor = (k: string) => { let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0; return OWNER_HUES[h % OWNER_HUES.length]; };
const initials = (n: string) => { const p = n.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean); return ((p[0]?.[0] || "?") + (p[1]?.[0] || "")).toUpperCase(); };

export default function OwnerClient({ id }: { id: string }) {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setErr(null);
    try {
      const res = await fetch(`/api/admin/deals/owners?id=${id}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const startEdit = () => {
    const o = data!.owner;
    setF({ name: o.name, kind: o.kind, company: o.company || "", emails: (o.emails || []).join(", "), phones: (o.phones || []).join(", "),
      links: (o.links || []).join(", "), reachability: o.reachability || "", notes: o.notes || "", negotiation_notes: o.negotiation_notes || "" });
    setEditing(true);
  };
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/deals/owners", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", id, ...f }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      await load(); setEditing(false);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setSaving(false); }
  };
  const del = async () => {
    if (!confirm(`Delete owner "${data!.owner.name}"? This can't be undone. Any linked deals keep their history but lose the owner link.`)) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/admin/deals/owners", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", id }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || `HTTP ${res.status}`); }
      router.push("/deals/owners");
    } catch (e) { setErr(String((e as Error)?.message || e)); setDeleting(false); }
  };

  if (err && !data) return <main><p style={{ color: "#a83265" }}>Couldn&apos;t load the owner: {err}</p></main>;
  if (!data) return <main><p className="muted">Loading…</p></main>;
  const o = data.owner;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: "0 12px" }}>
      <button style={{ ...btn, border: "none", padding: "4px 0", marginBottom: 8 }} onClick={() => router.push("/deals/owners")}>← Owners</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <span style={{ flex: "none", width: 44, height: 44, borderRadius: "50%", background: hueFor(o.name), color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700 }}>{initials(o.name)}</span>
          <div>
            <h1 style={{ fontSize: "1.4rem", margin: 0 }}>{o.name}</h1>
            <div className="muted" style={{ fontSize: 12.5 }}>{[o.kind !== "unknown" ? o.kind : null, o.company].filter(Boolean).join(" · ") || "—"}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {!editing
            ? <button style={btn} onClick={startEdit}>✎ Edit</button>
            : <>
                <button style={{ ...btn, color: "#a83265", borderColor: "#e2b8c6" }} onClick={del} disabled={saving || deleting}>{deleting ? "Deleting…" : "🗑 Delete"}</button>
                <button style={btn} onClick={() => setEditing(false)} disabled={saving || deleting}>Cancel</button>
                <button style={btnPrimary} onClick={save} disabled={saving || deleting}>{saving ? "Saving…" : "Save"}</button>
              </>}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, marginTop: 14 }}>
        {/* Contact + dossier */}
        <div style={card}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>Contact & dossier</div>
          {!editing ? <>
            <Field l="Emails" v={(o.emails || []).join("  ·  ") || null} />
            <Field l="Phones" v={(o.phones || []).join("  ·  ") || null} />
            <Field l="Links" v={(o.links || []).length ? o.links.join("\n") : null} />
            <Field l="Best way to reach" v={o.reachability} />
            <Field l="Notes" v={o.notes} />
          </> : <>
            <span style={lbl}>Name</span><input style={inp} value={f.name} onChange={(e) => set("name", e.target.value)} />
            <span style={lbl}>Type</span><select style={inp} value={f.kind} onChange={(e) => set("kind", e.target.value)}><option value="person">Person</option><option value="company">Company</option><option value="unknown">Unknown</option></select>
            <span style={lbl}>Company</span><input style={inp} value={f.company} onChange={(e) => set("company", e.target.value)} />
            <span style={lbl}>Emails (comma-separated)</span><input style={inp} value={f.emails} onChange={(e) => set("emails", e.target.value)} />
            <span style={lbl}>Phones (comma-separated)</span><input style={inp} value={f.phones} onChange={(e) => set("phones", e.target.value)} />
            <span style={lbl}>Links (comma-separated)</span><input style={inp} value={f.links} onChange={(e) => set("links", e.target.value)} />
            <span style={lbl}>Best way to reach</span><input style={inp} value={f.reachability} onChange={(e) => set("reachability", e.target.value)} />
            <span style={lbl}>Notes</span><textarea style={{ ...inp, minHeight: 70, resize: "vertical" }} value={f.notes} onChange={(e) => set("notes", e.target.value)} />
          </>}
        </div>

        {/* Negotiation history + the names we've worked with them */}
        <div>
          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 4 }}>💬 Negotiation history</div>
            <p className="muted" style={{ fontSize: 12, margin: "0 0 6px" }}>How this owner negotiates — accrues over deals (a line is appended each time a deal with them reaches Negotiating).</p>
            {!editing
              ? <div style={{ ...readVal, whiteSpace: "pre-wrap", color: o.negotiation_notes ? "var(--navy,#254254)" : "var(--muted,#aab)" }}>{o.negotiation_notes || "— nothing recorded yet"}</div>
              : <textarea style={{ ...inp, minHeight: 120, resize: "vertical" }} value={f.negotiation_notes} onChange={(e) => set("negotiation_notes", e.target.value)} placeholder="e.g. Anchors high, comes down ~30% over two weeks; responsive by text, not email." />}
          </div>

          <div style={card}>
            <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Names we&apos;ve worked with them ({data.deals.length + (data.acquisitions?.length || 0)})</div>
            {(data.acquisitions?.length || 0) > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: data.deals.length ? 10 : 0 }}>
                {data.acquisitions!.map((a) => (
                  <div key={a.domain} style={{ background: "var(--paper-2,#f7f5ef)", border: "1px solid var(--line,#eee6d6)", borderRadius: 8, padding: "8px 10px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <span><span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)" }}>{a.domain}</span> <span style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)" }}>· acquired</span></span>
                    <span style={{ flex: "none", fontSize: 12, color: "var(--navy-2,#4a5b66)" }}>{a.price || "—"}<span style={{ color: "var(--muted,#aab)" }}>{a.date ? ` · ${a.date}` : ""}</span></span>
                  </div>
                ))}
              </div>
            )}
            {data.deals.length ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {data.deals.map((d) => (
                  <button key={d.id} onClick={() => router.push(`/deals/${d.id}`)}
                    style={{ textAlign: "left", cursor: "pointer", background: "var(--paper-2,#f7f5ef)", border: "1px solid var(--line,#eee6d6)", borderRadius: 8, padding: "8px 10px", display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                    <span><span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)" }}>{d.domain}</span> <span style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)" }}>· {d.stage}</span></span>
                    <span style={{ flex: "none", fontSize: 12, color: "var(--navy-2,#4a5b66)" }}>{d.status === "won" ? `✓ ${usd(d.sale_price || d.asking_price)}` : (d.status === "open" ? usd(d.asking_price) : d.status)}<span style={{ color: "var(--muted,#aab)" }}> · {when(d.updated_at)}</span></span>
                  </button>
                ))}
              </div>
            ) : (!(data.acquisitions?.length) && <div className="muted" style={{ fontSize: 12.5 }}>No linked deals yet.</div>)}
          </div>
        </div>
      </div>
    </main>
  );
}

function Field({ l, v }: { l: string; v: string | null | undefined }) {
  return (
    <div style={{ marginTop: 8 }}>
      <span style={lbl}>{l}</span>
      <div style={{ ...readVal, whiteSpace: "pre-wrap", color: (v == null || v === "") ? "var(--muted,#aab)" : "var(--navy,#254254)" }}>{v || "—"}</div>
    </div>
  );
}
