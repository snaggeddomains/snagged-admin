"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { STAGES, PRIORITIES, SOURCES, BUDGET_BANDS, LOST_REASONS, NOT_PROCEEDED_REASONS, statusLabel } from "@/lib/deals/stages";
import ConfirmOwnerModal, { type ConfirmOwnerSeed } from "../confirm-owner-modal";

const NEGOTIATING = "Negotiating";

type Deal = {
  id: string; domain: string; buyer_name: string | null; buyer_email: string | null; org_name: string | null;
  budget_range: string | null; appraisal_value: number | null; asking_price: number | null;
  source: string | null; priority: string | null; owner_email: string | null; stage: string; status: string;
  tags: string[] | null; updated_at: string;
  likely_owner: string | null; owner_contact: string | null; domain_owner_id: string | null;
};
type Assignee = { email: string; name: string };
type Stats = { open: number; pipelineValue: number; byStage: Record<string, number> };
type Heartbeat = { name: string; last_run_at: string; last_result: Record<string, unknown> | null };
type Resp = { ok: boolean; configured: boolean; deals: Deal[]; stats: Stats | null; assignees: Assignee[]; emailSync?: Heartbeat | null; canSeeAll: boolean; me: string; error?: string };

// "42 min ago" / "3 hours ago" — for the email-cron heartbeat line.
function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0 || !Number.isFinite(diff)) return "just now";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };
const PRIORITY_COLOR: Record<string, string> = { Top: "#a83265", High: "#c0492f", Normal: "#4a5b66", Low: "#8a94a0" };
const PRIORITY_RANK: Record<string, number> = { Top: 0, High: 1, Normal: 2, Low: 3 };

// Maximally-separated hues so each owner is instantly distinguishable (teal, orange,
// purple, green, gold, indigo, magenta, …). Colors are assigned by the owner's INDEX
// in the team list (below), not a hash — a hash collides similar reds (Rob vs Sam).
const OWNER_PALETTE = ["#2f6f7a", "#c0492f", "#6b4a8a", "#2f7d4f", "#946200", "#3f4a8f", "#a83265", "#1f7a5a", "#8a5a2b", "#5a6b30"];
function hashColor(email: string): string {
  let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0;
  return OWNER_PALETTE[h % OWNER_PALETTE.length];
}

export default function BoardClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("open");
  const [mine, setMine] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState("");
  const [budgetFilter, setBudgetFilter] = useState("");
  const [q, setQ] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false);
  const [lostFor, setLostFor] = useState<string | null>(null); // deal id awaiting a lost reason
  const [notProceededFor, setNotProceededFor] = useState<string | null>(null); // deal id awaiting a "didn't proceed" reason
  const [wonFor, setWonFor] = useState<string | null>(null);   // deal id awaiting close-won details
  const [negSeed, setNegSeed] = useState<ConfirmOwnerSeed | null>(null); // confirm-owner on move to Negotiating

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const p = new URLSearchParams();
      if (status !== "all") p.set("status", status);
      if (q) p.set("q", q);
      const res = await fetch(`/api/admin/deals?${p.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  // Default "My deals" ON for people who can see everyone's — so an all-viewer lands on
  // their own deals first. Applied once (they can still toggle it off).
  const mineDefaulted = useRef(false);
  useEffect(() => {
    if (!mineDefaulted.current && data?.canSeeAll) { mineDefaulted.current = true; setMine(true); }
  }, [data?.canSeeAll]);

  const nameFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of data?.assignees || []) m.set(a.email.toLowerCase(), a.name);
    return (email: string | null) => email ? (m.get(email.toLowerCase()) || email.split("@")[0]) : "Inbox";
  }, [data]);
  // First name only on the card (fuller name lives on the detail page).
  const firstNameFor = useCallback((email: string | null) => {
    const n = nameFor(email);
    return n === "Inbox" ? "Inbox" : n.split(/\s+/)[0];
  }, [nameFor]);
  // Distinct color per owner, assigned by index in the sorted team list so no two
  // teammates ever collide on a hue.
  const colorFor = useMemo(() => {
    const emails = (data?.assignees || []).map((a) => a.email.toLowerCase())
      .filter((e, i, arr) => arr.indexOf(e) === i).sort();
    const m = new Map<string, string>();
    emails.forEach((e, i) => m.set(e, OWNER_PALETTE[i % OWNER_PALETTE.length]));
    return (email: string | null) => email ? (m.get(email.toLowerCase()) || hashColor(email)) : "#b7bcc2";
  }, [data]);

  const deals = useMemo(() => {
    let all = data?.deals || [];
    if (mine && data) all = all.filter((d) => (d.owner_email || "").toLowerCase() === data.me.toLowerCase());
    if (ownerFilter) all = all.filter((d) => ownerFilter === "__inbox__" ? !d.owner_email : (d.owner_email || "").toLowerCase() === ownerFilter.toLowerCase());
    if (budgetFilter) all = all.filter((d) => (d.budget_range || "") === budgetFilter);
    return all;
  }, [data, mine, ownerFilter, budgetFilter]);

  // Within a column, float higher-priority deals to the top (Top → High → Normal → Low →
  // none), keeping the manual drag order (position) as the tiebreak.
  const byStage = useMemo(() => {
    const rank = (p: string | null) => PRIORITY_RANK[p || ""] ?? 4;
    const m: Record<string, Deal[]> = {};
    for (const s of STAGES) m[s] = [];
    for (const d of deals) (m[d.stage] || (m[d.stage] = [])).push(d);
    for (const s of Object.keys(m)) m[s].sort((a, b) => rank(a.priority) - rank(b.priority));
    return m;
  }, [deals]);

  const stageDrag = status === "open"; // stage columns only accept drops in the Open view
  const dragDeal = dragId ? (data?.deals || []).find((x) => x.id === dragId) : null;
  const move = async (id: string, stage: string) => {
    const d = (data?.deals || []).find((x) => x.id === id);
    if (!d || d.stage === stage) return;
    setData((prev) => prev ? { ...prev, deals: prev.deals.map((x) => x.id === id ? { ...x, stage } : x) } : prev);
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stage }) });
      if (!res.ok) throw new Error();
    } catch { load(); }
  };
  // Terminal transitions — dropping a card on the Lost/Archive zones. Lost captures a
  // reason (via the modal); Archive parks a test/spam/dead deal off the board.
  const markStatus = async (id: string, newStatus: "lost" | "archived" | "open" | "won" | "not_proceeded", lost_reason?: string) => {
    const body: Record<string, unknown> = { status: newStatus };
    if (newStatus === "lost" || newStatus === "not_proceeded") body.lost_reason = lost_reason || null;
    if (newStatus === "open") body.lost_reason = null; // reopening clears the reason
    try {
      const res = await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error();
    } finally { load(); }
  };
  // Close Won — capture the confirmed owner/contact, price paid, commission + a recap,
  // set status=won, and log the recap to the timeline.
  const closeWon = async (id: string, f: WonForm) => {
    const patch: Record<string, unknown> = { status: "won" };
    if (f.ownerName.trim()) patch.likely_owner = f.ownerName.trim();
    if (f.ownerContact.trim()) patch.owner_contact = f.ownerContact.trim();
    const price = Number(String(f.pricePaid).replace(/[^0-9.]/g, ""));
    const comm = Number(String(f.commission).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(price) && price > 0) patch.sale_price = price;
    if (Number.isFinite(comm) && comm > 0) patch.commission = comm;
    try {
      await fetch(`/api/admin/deals/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
      const lines = [
        "🏆 Closed WON",
        f.ownerName.trim() && `Owner: ${f.ownerName.trim()}`,
        f.ownerContact.trim() && `Owner contact: ${f.ownerContact.trim()}`,
        Number.isFinite(price) && price > 0 && `Price paid: $${price.toLocaleString()}`,
        Number.isFinite(comm) && comm > 0 && `Commission: $${comm.toLocaleString()}`,
        f.recap.trim() && `\n${f.recap.trim()}`,
      ].filter(Boolean).join("\n");
      await fetch(`/api/admin/deals/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "comment", body: lines, mentions: [] }) });
    } finally { load(); }
  };

  return (
    <main style={{ width: "100%", padding: "0 12px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Deal board</h1>
          {data?.stats && <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>{data.stats.open} open · {usd(data.stats.pipelineValue)} in pipeline</p>}
          {data && "emailSync" in data && (
            <p className="muted" style={{ margin: "2px 0 0", fontSize: 11.5 }} title={data.emailSync?.last_run_at ? new Date(data.emailSync.last_run_at).toLocaleString() : "The hourly email-sync cron has not run yet"}>
              📥 Email auto-sync: {data.emailSync ? ago(data.emailSync.last_run_at) : "not run yet"}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input style={{ ...input, flex: "1 1 160px", minWidth: 140, maxWidth: 240 }} placeholder="Search domain / buyer…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <select style={{ ...input, width: "auto" }} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="not_proceeded">Didn&apos;t proceed</option><option value="archived">Archived</option><option value="all">All</option>
          </select>
          <select style={{ ...input, width: "auto" }} value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)} title="Filter by owner">
            <option value="">All owners</option>
            <option value="__inbox__">Unassigned</option>
            {(data?.assignees || []).map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
          <select style={{ ...input, width: "auto" }} value={budgetFilter} onChange={(e) => setBudgetFilter(e.target.value)} title="Filter by budget">
            <option value="">All budgets</option>
            {BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
          {(ownerFilter || budgetFilter) && <button style={btn} onClick={() => { setOwnerFilter(""); setBudgetFilter(""); }}>Clear</button>}
          {data?.canSeeAll && (
            <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> My deals
            </label>
          )}
          <button style={btn} onClick={() => setShowPrefs(true)} title="Notification preferences">🔔</button>
          <button style={btn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
          <button style={btnPrimary} onClick={() => setShowNew(true)}>+ New deal</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load deals: {err}</div>}
      {data && !data.configured && <div style={{ margin: "12px 0" }} className="muted">The deals database isn&apos;t set up yet — run <code>scripts/deals.sql</code>.</div>}

      {/* Full-width board: columns grow to fill the window, scroll only when too narrow. */}
      <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 16, marginTop: 14, alignItems: "flex-start" }}>
        {STAGES.map((stage) => {
          const col = byStage[stage] || [];
          const over = dragOver === stage;
          return (
            <div key={stage}
              onDragOver={(e) => { if (stageDrag) { e.preventDefault(); setDragOver(stage); } }}
              onDragLeave={() => setDragOver((s) => s === stage ? null : s)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(null);
                if (stageDrag && dragId) {
                  // Dropping on a terminal column runs the close flow (confirm details / reason).
                  if (stage === "Closed - Won") { const id = dragId; setDragId(null); setWonFor(id); return; }
                  if (stage === "Closed - Lost") { const id = dragId; setDragId(null); setLostFor(id); return; }
                  const dropped = (data?.deals || []).find((x) => x.id === dragId);
                  move(dragId, stage);
                  // Reaching Negotiating = we're confident who owns it → capture/confirm the owner.
                  // (Skip if this deal already has an owner record.)
                  if (stage === NEGOTIATING && dropped && !dropped.domain_owner_id) {
                    setNegSeed({ dealId: dropped.id, domain: dropped.domain, likelyOwner: dropped.likely_owner, ownerContact: dropped.owner_contact, company: dropped.org_name });
                  }
                }
                setDragId(null);
              }}
              style={{ flex: "1 0 210px", minWidth: 210, background: over ? "#eef4f0" : "var(--paper-2,#f4f1ea)", borderRadius: 10, padding: 8, minHeight: 120, border: over ? "1.5px dashed var(--coral,#e2674a)" : "1.5px solid transparent" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 4px 8px" }}>
                <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--navy,#254254)" }}>{stage}</span>
                <span style={{ fontSize: 12, color: "var(--muted,#889)" }}>{col.length}</span>
              </div>
              {col.map((d) => {
                const oc = colorFor(d.owner_email);
                return (
                  <div key={d.id}
                    draggable
                    onDragStart={() => setDragId(d.id)}
                    onDragEnd={() => { setDragId(null); setDragOver(null); }}
                    onClick={() => router.push(`/deals/${d.id}`)}
                    style={{ background: "#fff", border: "1px solid var(--line,#e6e0d3)", borderLeft: `4px solid ${oc}`, borderRadius: 8, padding: "9px 10px", marginBottom: 8, cursor: "grab", boxShadow: "0 1px 2px rgba(0,0,0,0.04)", opacity: dragId === d.id ? 0.5 : 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: "var(--navy,#254254)" }}>{d.domain}</span>
                      {d.priority && <span style={{ fontSize: 10.5, fontWeight: 700, color: PRIORITY_COLOR[d.priority] || "#4a5b66" }}>{d.priority}</span>}
                    </div>
                    {(d.buyer_name || d.buyer_email) && <div style={{ fontSize: 12, color: "var(--navy-2,#4a5b66)", marginTop: 3 }}>{d.buyer_name || d.buyer_email}</div>}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: oc, display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: oc, display: "inline-block" }} />{firstNameFor(d.owner_email)}
                      </span>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--navy-2,#4a5b66)" }}>{d.budget_range || usd(d.asking_price || d.appraisal_value)}</span>
                    </div>
                    {d.status !== "open" && <div style={{ fontSize: 10.5, fontWeight: 700, marginTop: 4, color: d.status === "won" ? "#1f7a5a" : d.status === "not_proceeded" ? "#b26a00" : d.status === "archived" ? "#7a6f63" : "#a83265" }}>{statusLabel(d.status).toUpperCase()}</div>}
                  </div>
                );
              })}
              {!col.length && <div style={{ fontSize: 12, color: "var(--muted,#aab)", textAlign: "center", padding: "10px 0" }}>—</div>}
            </div>
          );
        })}
      </div>

      {/* Drop a card here to close it out — appears while dragging, tailored to the
          dragged card's current status (reopen a lost/archived one, archive/lose an open one). */}
      {dragId && (
        <div style={{ display: "flex", gap: 10, marginTop: 4, paddingBottom: 8 }}>
          {/* Close Won only at the final stage (Negotiating) — not at every step. */}
          {dragDeal?.status === "open" && dragDeal?.stage === STAGES[STAGES.length - 1] && (
            <DropZone label="✓ Close Won" hint="confirm the details" color="#1f7a5a"
              onDrop={() => { const id = dragId; setDragId(null); setDragOver(null); setWonFor(id); }} />
          )}
          {dragDeal?.status !== "lost" && (
            <DropZone label="✗ Mark Lost" hint="pick a reason" color="#a83265"
              onDrop={() => { const id = dragId; setDragId(null); setDragOver(null); setLostFor(id); }} />
          )}
          {dragDeal?.status !== "not_proceeded" && (
            <DropZone label="🚫 Didn't proceed" hint="buyer bailed early" color="#b26a00"
              onDrop={() => { const id = dragId; setDragId(null); setDragOver(null); setNotProceededFor(id); }} />
          )}
          {dragDeal?.status !== "archived" && (
            <DropZone label="🗄 Archive (test / spam)" hint="off the board" color="#7a6f63"
              onDrop={() => { const id = dragId; setDragId(null); setDragOver(null); if (id && confirm("Archive this deal? It moves off the board (find it via the Archived filter).")) markStatus(id, "archived"); }} />
          )}
          {dragDeal && dragDeal.status !== "open" && (
            <DropZone label="↩ Reopen" hint="back to Open" color="#2f7d4f"
              onDrop={() => { const id = dragId; setDragId(null); setDragOver(null); if (id) markStatus(id, "open"); }} />
          )}
        </div>
      )}

      {showNew && <NewDealModal assignees={data?.assignees || []} onClose={() => setShowNew(false)} onCreated={(id) => { setShowNew(false); router.push(`/deals/${id}`); }} />}
      {showPrefs && <PrefsModal onClose={() => setShowPrefs(false)} />}
      {lostFor && <LostModal onClose={() => setLostFor(null)} onPick={(reason) => { const id = lostFor; setLostFor(null); if (id) markStatus(id, "lost", reason); }} />}
      {notProceededFor && <ReasonModal title="Didn't proceed — why?" reasons={NOT_PROCEEDED_REASONS} onClose={() => setNotProceededFor(null)} onPick={(reason) => { const id = notProceededFor; setNotProceededFor(null); if (id) markStatus(id, "not_proceeded", reason); }} />}
      {wonFor && <WonModal onClose={() => setWonFor(null)} onSubmit={(f) => { const id = wonFor; setWonFor(null); if (id) closeWon(id, f); }} />}
      {negSeed && <ConfirmOwnerModal seed={negSeed} onClose={() => setNegSeed(null)} onDone={() => { setNegSeed(null); load(); }} />}
    </main>
  );
}

type WonForm = { ownerName: string; ownerContact: string; pricePaid: string; commission: string; recap: string };

// Confirm-before-Won: capture the owner + contact, price paid, commission, and a recap
// before a deal is marked won. Nothing here is optional-gated — it's a deliberate stop.
function WonModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (f: WonForm) => void }) {
  const [f, setF] = useState<WonForm>({ ownerName: "", ownerContact: "", pricePaid: "", commission: "", recap: "" });
  const set = (k: keyof WonForm, v: string) => setF((s) => ({ ...s, [k]: v }));
  const L: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(440px,100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 2px" }}>🏆 Close deal — Won</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 6px" }}>Confirm the details before marking this deal won.</p>
        <label style={L}>Owner name</label>
        <input style={input} value={f.ownerName} onChange={(e) => set("ownerName", e.target.value)} placeholder="Who we bought from" />
        <label style={L}>Owner contact</label>
        <input style={input} value={f.ownerContact} onChange={(e) => set("ownerContact", e.target.value)} placeholder="Email / phone" />
        <label style={L}>Price paid</label>
        <input style={input} value={f.pricePaid} onChange={(e) => set("pricePaid", e.target.value)} placeholder="$" inputMode="decimal" />
        <label style={L}>Commission</label>
        <input style={input} value={f.commission} onChange={(e) => set("commission", e.target.value)} placeholder="$" inputMode="decimal" />
        <label style={L}>Recap / deal notes</label>
        <textarea style={{ ...input, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={f.recap} onChange={(e) => set("recap", e.target.value)} placeholder="How it closed, terms, next steps…" />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose}>Cancel</button>
          <button style={{ ...btnPrimary, background: "#1f7a5a", borderColor: "#1f7a5a" }} onClick={() => onSubmit(f)}>✓ Mark Won</button>
        </div>
      </div>
    </div>
  );
}

// A terminal-transition drop target (Lost / Archive), highlighted on drag-over.
function DropZone({ label, hint, color, onDrop }: { label: string; hint: string; color: string; onDrop: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(); }}
      style={{ flex: 1, textAlign: "center", padding: "14px 10px", borderRadius: 10, border: `1.5px dashed ${color}`, background: over ? color : "transparent", color: over ? "#fff" : color, fontWeight: 700, fontSize: 13, transition: "background .1s" }}>
      {label} <span style={{ fontWeight: 500, opacity: 0.8, fontSize: 12 }}>· {hint}</span>
    </div>
  );
}

// Generic reason picker (Lost / Didn't proceed) — presets, "Other" → free text.
function LostModal({ onClose, onPick }: { onClose: () => void; onPick: (reason: string) => void }) {
  return <ReasonModal title="Why lost?" reasons={LOST_REASONS} onClose={onClose} onPick={onPick} />;
}
function ReasonModal({ title, reasons, onClose, onPick }: { title: string; reasons: readonly string[]; onClose: () => void; onPick: (reason: string) => void }) {
  const [other, setOther] = useState("");
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(380px,100%)" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 10px" }}>{title}</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {reasons.filter((r) => r !== "Other").map((r) => (
            <button key={r} style={{ ...btn, textAlign: "left", padding: "9px 12px" }} onClick={() => onPick(r)}>{r}</button>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input style={{ ...input, flex: 1 }} placeholder="Other reason…" value={other} onChange={(e) => setOther(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && other.trim()) onPick(other.trim()); }} />
            <button style={btnPrimary} disabled={!other.trim()} onClick={() => onPick(other.trim())}>Save</button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <button style={btn} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function PrefsModal({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState<{ in_app: boolean; email: boolean; slack: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { fetch("/api/deals/notif-prefs").then((r) => r.json()).then((j) => setP(j.prefs || { in_app: true, email: true, slack: true })).catch(() => setP({ in_app: true, email: true, slack: true })); }, []);
  const save = async () => {
    if (!p) return; setSaving(true);
    try { await fetch("/api/deals/notif-prefs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }); onClose(); }
    finally { setSaving(false); }
  };
  const Row = ({ k, label, hint }: { k: "in_app" | "email" | "slack"; label: string; hint: string }) => (
    <label style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 0", cursor: "pointer" }}>
      <input type="checkbox" checked={!!p?.[k]} onChange={(e) => setP((s) => s ? { ...s, [k]: e.target.checked } : s)} style={{ marginTop: 3 }} />
      <span><span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span><br /><span className="muted" style={{ fontSize: 12 }}>{hint}</span></span>
    </label>
  );
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(400px,100%)" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 2px" }}>Deal notifications</h2>
        <p className="muted" style={{ fontSize: 12.5, margin: "0 0 8px" }}>How you get notified about deals assigned to you, stage changes, and @mentions.</p>
        {!p ? <p className="muted">Loading…</p> : <>
          <Row k="in_app" label="In-app bell" hint="The notification bell in the top bar." />
          <Row k="email" label="Email" hint="An email to your inbox." />
          <Row k="slack" label="Slack DM" hint="A direct message from the Snagged bot (needs Slack workspace access)." />
        </>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button style={btn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={btnPrimary} onClick={save} disabled={saving || !p}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

function NewDealModal({ assignees, onClose, onCreated }: { assignees: Assignee[]; onClose: () => void; onCreated: (id: string) => void }) {
  const [f, setF] = useState({ domain: "", buyerName: "", buyerEmail: "", orgName: "", budgetRange: "", source: SOURCES[0] as string, priority: "", ownerEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((s) => ({ ...s, [k]: v }));

  // Returning-client typeahead: look up known buyers from prior deals as you type the name.
  const [buyerHits, setBuyerHits] = useState<{ name: string | null; email: string | null; company: string | null }[]>([]);
  const [buyerOpen, setBuyerOpen] = useState(false);
  const pickedRef = useRef(false);
  useEffect(() => {
    if (pickedRef.current) { pickedRef.current = false; return; }
    const term = f.buyerName.trim();
    if (term.length < 2) { setBuyerHits([]); return; }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/admin/deals?buyers=${encodeURIComponent(term)}`);
        const j = await res.json();
        if (!dead && Array.isArray(j.buyers)) { setBuyerHits(j.buyers); setBuyerOpen(true); }
      } catch { /* ignore */ }
    }, 220);
    return () => { dead = true; clearTimeout(t); };
  }, [f.buyerName]);
  const pickBuyer = (b: { name: string | null; email: string | null; company: string | null }) => {
    pickedRef.current = true;
    setF((s) => ({ ...s, buyerName: b.name || s.buyerName, buyerEmail: b.email || s.buyerEmail, orgName: b.company || s.orgName }));
    setBuyerOpen(false);
    setBuyerHits([]);
  };
  const submit = async () => {
    if (!f.domain.trim()) { setError("Domain is required."); return; }
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/admin/deals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, domain: f.domain.trim() }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onCreated(j.deal.id);
    } catch (e) { setError(String((e as Error)?.message || e)); setBusy(false); }
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(440px,100%)", maxHeight: "90vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.1rem", margin: "0 0 4px" }}>New deal</h2>
        <label style={fieldLabel}>Target domain *</label>
        <input style={input} value={f.domain} onChange={(e) => set("domain", e.target.value)} placeholder="example.com" />
        <label style={fieldLabel}>Buyer name</label>
        <div style={{ position: "relative" }}>
          <input style={input} value={f.buyerName} autoComplete="off"
            onChange={(e) => set("buyerName", e.target.value)}
            onFocus={() => { if (buyerHits.length) setBuyerOpen(true); }}
            onBlur={() => setTimeout(() => setBuyerOpen(false), 150)} />
          {buyerOpen && buyerHits.length > 0 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 10, background: "var(--paper,#fff)", border: "1px solid var(--line,#e3ddcf)", borderRadius: 8, marginTop: 3, boxShadow: "0 6px 18px rgba(20,25,30,0.12)", maxHeight: 220, overflowY: "auto" }}>
              {buyerHits.map((b, i) => (
                <button key={`${b.email || b.name}-${i}`} type="button" onMouseDown={(e) => { e.preventDefault(); pickBuyer(b); }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", background: "transparent", border: "none", borderBottom: i < buyerHits.length - 1 ? "1px solid var(--line,#eee6d6)" : "none", cursor: "pointer", fontSize: 13 }}>
                  <span style={{ fontWeight: 600 }}>{b.name || b.email}</span>
                  {(b.email || b.company) && <span style={{ color: "var(--navy-2,#8a94a0)" }}>{" · "}{[b.email, b.company].filter(Boolean).join(" · ")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <label style={fieldLabel}>Buyer email</label>
        <input style={input} value={f.buyerEmail} onChange={(e) => set("buyerEmail", e.target.value)} />
        <label style={fieldLabel}>Company</label>
        <input style={input} value={f.orgName} onChange={(e) => set("orgName", e.target.value)} />
        <label style={fieldLabel}>Budget range</label>
        <select style={input} value={f.budgetRange} onChange={(e) => set("budgetRange", e.target.value)}>
          <option value="">—</option>{BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <label style={fieldLabel}>Source</label>
        <select style={input} value={f.source} onChange={(e) => set("source", e.target.value)}>{SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
        <label style={fieldLabel}>Priority</label>
        <select style={input} value={f.priority} onChange={(e) => set("priority", e.target.value)}><option value="">—</option>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        <label style={fieldLabel}>Assign to</label>
        <select style={input} value={f.ownerEmail} onChange={(e) => set("ownerEmail", e.target.value)}>
          <option value="">Unassigned / Inbox</option>
          {assignees.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btn} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btnPrimary} onClick={submit} disabled={busy || !f.domain.trim()}>{busy ? "Creating…" : "Create deal"}</button>
        </div>
      </div>
    </div>
  );
}
