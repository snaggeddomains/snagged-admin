"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type Card = {
  id: string; domain: string; txn_date: string | null; txn_price: string | null;
  candidate_name: string | null; candidate_first_name: string | null;
  candidate_email: string | null; candidate_phone: string | null;
  channel: string | null; buyer_context: string | null; confidence: string | null;
  evidence: string | null; notes: string | null; status: string;
  assigned_to: string | null; reviewed_by: string | null; reviewed_at: string | null;
  deal_owner_id: string | null; source: string; created_at: string;
};
type Reviewer = { email: string; name: string };
type Resp = { ok: boolean; configured?: boolean; cards: Card[]; myPending: number; reviewers: Reviewer[]; me?: string; error?: string };

const btn: CSSProperties = { padding: "5px 11px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const btnGood: CSSProperties = { ...btn, background: "#2f7d4f", color: "#fff", borderColor: "#2f7d4f" };
const input: CSSProperties = { padding: "6px 8px", borderRadius: 6, border: "1px solid var(--line,#e3ddcf)", fontSize: 13, boxSizing: "border-box", width: "100%" };
const L: CSSProperties = { display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted,#8a94a0)", margin: "8px 0 2px" };

const CONF_HUE: Record<string, string> = { high: "#2f7d4f", medium: "#946200", low: "#c0492f", broker: "#6b4a8a", none: "#8a94a0" };
const STATUSES = [
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "rejected", label: "Rejected" },
  { key: "skipped", label: "Skipped" },
  { key: "all", label: "All" },
];

export default function OwnerReviewClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("pending");
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams({ status, scope }); if (q) p.set("q", q);
      const res = await fetch(`/api/admin/deals/owner-review?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [status, scope, q]);
  useEffect(() => { load(); }, [load]);

  const cards = data?.cards || [];
  const reviewers = data?.reviewers || [];

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "0 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Owner Review</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Confirm who we <strong>bought each name from</strong> — the owner surfaced from the acquisition emails. Confirm → the owner is saved to the Owners directory + linked to the deal. Reject if it&apos;s not a real seller (broker / auction / the buyer).</p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, minWidth: 180, width: "auto" }} placeholder="Search domain / candidate…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "14px 0 4px" }}>
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setStatus(s.key)}
            style={{ ...btn, ...(status === s.key ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }}>{s.label}</button>
        ))}
        <span style={{ width: 1, height: 18, background: "var(--line,#e3ddcf)", margin: "0 4px" }} />
        <button style={{ ...btn, ...(scope === "mine" ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }} onClick={() => setScope("mine")}>Assigned to me</button>
        <button style={{ ...btn, ...(scope === "all" ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }} onClick={() => setScope("all")}>Everyone</button>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load: {err}</div>}
      {data && data.configured === false && <div style={{ margin: "12px 0" }} className="muted">The Owner Review queue isn&apos;t set up yet — run <code>scripts/owner_review.sql</code> on the main project.</div>}

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
        {cards.map((c) => <ReviewCard key={c.id} card={c} reviewers={reviewers} onChanged={load} />)}
        {!loading && !cards.length && !err && <div className="muted" style={{ fontSize: 13, padding: "8px 2px" }}>{scope === "mine" ? "Nothing assigned to you in this view." : "No cards in this view."}</div>}
      </div>
    </main>
  );
}

function ReviewCard({ card, reviewers, onChanged }: { card: Card; reviewers: Reviewer[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({
    candidate_name: card.candidate_name || "", candidate_first_name: card.candidate_first_name || "",
    candidate_email: card.candidate_email || "", candidate_phone: card.candidate_phone || "",
    channel: card.channel || "", buyer_context: card.buyer_context || "",
    confidence: card.confidence || "", evidence: card.evidence || "", notes: card.notes || "",
  });
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action); setMsg(null);
    try {
      const res = await fetch(`/api/admin/deals/owner-review/${card.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, patch: f, ...extra }),
      });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      if (action === "confirm") setMsg(`✓ Saved to Owners${j.linked ? ` · linked ${j.linked} deal${j.linked === 1 ? "" : "s"}` : ""}`);
      onChanged();
    } catch (e) { setMsg(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };

  const confHue = CONF_HUE[(card.confidence || "").toLowerCase()] || "#8a94a0";
  const done = card.status !== "pending";

  return (
    <div style={{ border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 14, background: "var(--paper,#fff)", opacity: done ? 0.72 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, fontSize: 15, color: "var(--navy,#254254)" }}>{card.domain}</span>
        <span style={{ fontSize: 11.5, color: "var(--muted,#8a94a0)" }}>{[card.txn_date, card.txn_price].filter(Boolean).join(" · ")}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0 2px", alignItems: "center" }}>
        {card.channel && <Chip>{card.channel}</Chip>}
        {card.confidence && <span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: confHue, borderRadius: 999, padding: "1px 8px", textTransform: "uppercase", letterSpacing: 0.3 }}>{card.confidence}</span>}
        {card.status !== "pending" && <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "1px 8px", textTransform: "uppercase" }}>{card.status}</span>}
      </div>

      {!editing ? (
        <div style={{ marginTop: 6, fontSize: 13 }}>
          {(card.candidate_name || card.candidate_first_name) ? (
            <div style={{ fontWeight: 600, color: "var(--navy,#254254)" }}>{card.candidate_name || card.candidate_first_name}{card.candidate_first_name && card.candidate_name && card.candidate_first_name !== card.candidate_name ? ` (${card.candidate_first_name})` : ""}</div>
          ) : <div className="muted" style={{ fontStyle: "italic" }}>No candidate seller named</div>}
          {card.candidate_email && <div style={{ color: "var(--navy-2,#4a5b66)", marginTop: 2 }}>✉ {card.candidate_email}</div>}
          {card.candidate_phone && <div style={{ color: "var(--navy-2,#4a5b66)", marginTop: 2 }}>☎ {card.candidate_phone}</div>}
          {card.buyer_context && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>👤 Buyer/context: {card.buyer_context}</div>}
          {card.evidence && <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>🔎 {card.evidence}</div>}
        </div>
      ) : (
        <div style={{ marginTop: 4 }}>
          <label style={L}>Owner / seller name</label>
          <input style={input} value={f.candidate_name} onChange={(e) => set("candidate_name", e.target.value)} placeholder="Full name (leave blank if unknown)" />
          <label style={L}>First name</label>
          <input style={input} value={f.candidate_first_name} onChange={(e) => set("candidate_first_name", e.target.value)} placeholder="e.g. Michel" />
          <label style={L}>Email</label>
          <input style={input} value={f.candidate_email} onChange={(e) => set("candidate_email", e.target.value)} />
          <label style={L}>Phone</label>
          <input style={input} value={f.candidate_phone} onChange={(e) => set("candidate_phone", e.target.value)} />
          <label style={L}>Channel</label>
          <input style={input} value={f.channel} onChange={(e) => set("channel", e.target.value)} placeholder="Escrow.com / Direct / GoDaddy …" />
          <label style={L}>Evidence / note</label>
          <textarea style={{ ...input, minHeight: 44, resize: "vertical" }} value={f.evidence} onChange={(e) => set("evidence", e.target.value)} />
        </div>
      )}

      {msg && <div style={{ marginTop: 8, fontSize: 12, color: msg.startsWith("✓") ? "#2f7d4f" : "#a83265" }}>{msg}</div>}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
        {!done && <button style={btnGood} disabled={!!busy} onClick={() => act("confirm")}>{busy === "confirm" ? "…" : "✓ Confirm owner"}</button>}
        <button style={btn} disabled={!!busy} onClick={() => { if (editing) act("edit"); else setEditing(true); }}>{editing ? (busy === "edit" ? "…" : "Save edits") : "✎ Edit"}</button>
        {editing && <button style={btn} onClick={() => setEditing(false)}>Cancel</button>}
        {!done && <button style={btn} disabled={!!busy} onClick={() => act("reject")}>✕ Reject</button>}
        {!done && <button style={btn} disabled={!!busy} onClick={() => act("skip")}>Skip</button>}
        {done && <button style={btn} disabled={!!busy} onClick={() => act("reopen")}>↩ Reopen</button>}
      </div>

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
        <span className="muted">Assigned:</span>
        <select style={{ ...input, width: "auto", padding: "3px 6px", fontSize: 12 }} value={card.assigned_to || ""} onChange={(e) => act("reassign", { assigned_to: e.target.value })} disabled={!!busy}>
          <option value="">Unassigned</option>
          {reviewers.map((r) => <option key={r.email} value={r.email}>{r.name}</option>)}
        </select>
        {card.deal_owner_id && <a href={`/deals/owners/${card.deal_owner_id}`} style={{ marginLeft: "auto", fontSize: 12, color: "var(--coral,#e2674a)", fontWeight: 600 }}>Owner record ↗</a>}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--navy-2,#4a5b66)", background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "1px 8px" }}>{children}</span>;
}
