"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Card = {
  id: string; domain: string; txn_date: string | null; txn_price: string | null;
  candidate_name: string | null; candidate_first_name: string | null; candidate_last_name: string | null;
  candidate_email: string | null; candidate_phone: string | null;
  channel: string | null; buyer_context: string | null; confidence: string | null;
  evidence: string | null; notes: string | null; status: string;
  assigned_to: string | null; reviewed_by: string | null; reviewed_at: string | null;
  deal_owner_id: string | null; source: string; created_at: string;
};
type Reviewer = { email: string; name: string };
type Mirror = { localOnly: boolean; lastSyncedAt: string | null; dataThrough: string | null; mailboxes: { mailbox: string; lastSyncedAt: string | null; messages: number }[] };
type Resp = { ok: boolean; configured?: boolean; cards: Card[]; myPending: number; reviewers: Reviewer[]; canMine?: boolean; me?: string; mirror?: Mirror | null; error?: string };

// Relative-time for the mirror badge.
function relTime(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const btn: CSSProperties = { padding: "8px 15px", borderRadius: 9, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13.5, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const btnGood: CSSProperties = { ...btn, background: "#2f7d4f", color: "#fff", borderColor: "#2f7d4f", padding: "9px 20px", fontSize: 14 };
const chipBtn: CSSProperties = { padding: "5px 11px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 12.5, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const input: CSSProperties = { padding: "8px 10px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box", width: "100%" };
const L: CSSProperties = { display: "block", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", color: "var(--muted,#8a94a0)", margin: "10px 0 3px" };

const CONF_HUE: Record<string, string> = { high: "#2f7d4f", medium: "#946200", low: "#c0492f", broker: "#6b4a8a", none: "#8a94a0" };
// Bought through a broker / marketplace / auction / registration → there's no ACTUAL owner to
// record (the whole point is a DB of real sellers), so Dismiss is the right call, not Confirm.
const NO_OWNER_CHANNEL = /godaddy|spaceship|afternic|sedo|\bdan\b|atom|namecheap|dropcatch|drop\s*catch|auction|escrow|registration|register|inbound|marketplace|namejet|namebright|sav\.com|dynadot|porkbun/i;
// Full name from explicit first/last, falling back to the stored candidate_name.
function fullName(card: Card): string {
  const fl = [card.candidate_first_name, card.candidate_last_name].map((s) => (s || "").trim()).filter(Boolean).join(" ");
  return fl || (card.candidate_name || "").trim();
}
function isNoOwner(card: Card): boolean {
  const conf = (card.confidence || "").toLowerCase();
  const named = !!(fullName(card) || card.candidate_email);
  if (named) return false;                        // a real seller was surfaced → not a no-owner card
  if (conf === "broker" || conf === "none") return true;
  return NO_OWNER_CHANNEL.test(card.channel || "");
}
const STATUSES = [
  { key: "pending", label: "Pending" },
  { key: "confirmed", label: "Confirmed" },
  { key: "rejected", label: "Rejected" },
  { key: "skipped", label: "Skipped" },
  { key: "dismissed", label: "Dismissed" },
  { key: "all", label: "All" },
];

export default function OwnerReviewClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState("pending");
  const [scope, setScope] = useState<string>("mine");   // "mine" (default) | "all" | a reviewer email
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const [mining, setMining] = useState(false);
  const [mineMsg, setMineMsg] = useState<string | null>(null);

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
  // Reset to the first card whenever the view (filter/scope/search) changes.
  useEffect(() => { setIdx(0); }, [status, scope, q]);

  const cards = useMemo(() => data?.cards || [], [data]);
  const reviewers = data?.reviewers || [];
  const clampedIdx = Math.min(idx, Math.max(0, cards.length - 1));
  const card = cards[clampedIdx];

  // After an action, drop the acted card from the working set and stay on the same index
  // (which now shows the next card), so it's a clean one-at-a-time flow.
  const afterAction = useCallback(() => {
    setData((d) => (d ? { ...d, cards: d.cards.filter((c) => c.id !== card?.id), myPending: Math.max(0, (d.myPending || 0) - (card?.status === "pending" ? 1 : 0)) } : d));
  }, [card]);

  // Re-mine a TEST batch of the wrong-looking cards (broker / no seller named) with the improved
  // whole-thread miner, assigning each to Judy. The cron drains the rest unattended; this button is
  // the manual test run to eyeball the new logic.
  const [remining, setRemining] = useState(false);
  const remineBulk = async (limit: number) => {
    setRemining(true); setMineMsg(`Re-mining ${limit} wrong card${limit === 1 ? "" : "s"} with the whole-thread miner…`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    try {
      const res = await fetch("/api/admin/deals/owner-review/remine-bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit }), signal: ctrl.signal });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.note) setMineMsg(`⚠️ ${j.note}`);
      else setMineMsg(`✓ Re-mined ${j.updated} → assigned Judy · found a real seller on ${j.found}/${j.scanned} · ${j.remaining} wrong card${j.remaining === 1 ? "" : "s"} left (the cron drains these automatically — 12 every 2 min)`);
      await load();
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError" ? "Still re-mining server-side — refresh in a minute to see the updated cards." : String((e as Error)?.message || e);
      setMineMsg(`⚠️ ${msg}`);
      await load().catch(() => {});
    } finally { clearTimeout(timer); setRemining(false); }
  };

  // Backfill the whole Master Txn list — mine each thread for the seller (one LLM batch per click,
  // bounded to fit the 300s route). Click again until "remaining" hits 0.
  const mine = async () => {
    setMining(true); setMineMsg("Mining acquisition threads… (a batch takes ~30–60s)");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);   // don't spin forever if the function runs long
    try {
      const res = await fetch("/api/admin/deals/owner-review/mine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 12 }), signal: ctrl.signal });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.note) setMineMsg(`⚠️ ${j.note}`);
      else setMineMsg(`✓ Created ${j.created} card${j.created === 1 ? "" : "s"} · ${j.remaining ?? 0} still to mine${j.remaining ? " — click again to continue" : " · backlog complete 🎉"}`);
      await load();
    } catch (e) {
      const msg = (e as Error)?.name === "AbortError"
        ? "Still mining server-side — the batch is running; refresh in a minute to see new cards, then click again to continue."
        : String((e as Error)?.message || e);
      setMineMsg(`⚠️ ${msg}`);
      await load().catch(() => {});
    } finally { clearTimeout(timer); setMining(false); }
  };

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "0 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Owner Review</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13, maxWidth: 620 }}>Confirm who we <strong>bought each name from</strong> — the owner surfaced from the acquisition emails. Confirm → the owner is saved to the Owners directory + linked to the deal. Reject if it&apos;s not a real seller (broker / auction / the buyer).</p>
          {data?.mirror && (
            <div title="Owner Review mines the LOCAL Gmail mirror only — it never calls the Gmail API, so it can't affect the shared throttle. The nightly delta sync keeps the mirror current." style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: 8, padding: "4px 10px", borderRadius: 999, background: data.mirror.localOnly ? "#e7f5ec" : "#fdf1e3", border: `1px solid ${data.mirror.localOnly ? "#b6e0c4" : "#eecfa6"}`, fontSize: 12, color: "#2f5d42", fontWeight: 600, maxWidth: "100%", flexWrap: "wrap" }}>
              <span aria-hidden style={{ width: 8, height: 8, borderRadius: 999, background: data.mirror.localOnly ? "#2f9e5f" : "#d08a2c", display: "inline-block" }} />
              {data.mirror.localOnly ? "🔒 Local mirror only — not reading Gmail" : "⚠︎ Live Gmail fallback ON"}
              <span style={{ color: "#6b7a70", fontWeight: 400 }}>
                · data through {data.mirror.dataThrough ? relTime(data.mirror.dataThrough) : "—"}
                {" · last Gmail sync "}{data.mirror.lastSyncedAt ? relTime(data.mirror.lastSyncedAt) : "Takeout import"}
              </span>
            </div>
          )}
        </div>
        {data?.canMine && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button style={{ ...btnGood, whiteSpace: "nowrap" }} disabled={mining || remining} onClick={mine} title="Mine the acquisition thread for every Master Txn without a card yet — pulls the seller + full name automatically. Runs in batches; click again to continue.">{mining ? "Mining…" : "⛏ Mine backlog"}</button>
            <button style={{ ...btn, whiteSpace: "nowrap" }} disabled={mining || remining} onClick={() => remineBulk(10)} title="Test run: re-mine 10 of the wrong-looking cards (broker / no seller named) with the improved whole-thread miner and assign them to Judy. The cron drains the rest automatically.">{remining ? "Re-mining…" : "🔁 Re-mine wrong → Judy (10)"}</button>
          </div>
        )}
      </div>
      {mineMsg && <div style={{ marginTop: 8, fontSize: 13, color: mineMsg.startsWith("⚠️") ? "#a83265" : (mineMsg.startsWith("✓") ? "#2f7d4f" : "var(--navy-2,#4a5b66)") }}>{mineMsg}</div>}

      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", margin: "14px 0 4px" }}>
        {STATUSES.map((s) => (
          <button key={s.key} onClick={() => setStatus(s.key)}
            style={{ ...chipBtn, ...(status === s.key ? { background: "var(--navy,#254254)", color: "#fff", borderColor: "var(--navy,#254254)" } : {}) }}>{s.label}</button>
        ))}
        <span style={{ width: 1, height: 18, background: "var(--line,#e3ddcf)", margin: "0 4px" }} />
        <select value={scope} onChange={(e) => setScope(e.target.value)} title="Whose cards to show"
          style={{ ...input, width: "auto", padding: "6px 8px", fontWeight: 600, background: scope === "mine" ? "var(--navy,#254254)" : "transparent", color: scope === "mine" ? "#fff" : "var(--navy,#254254)", borderColor: scope === "mine" ? "var(--navy,#254254)" : "var(--line,#e3ddcf)" }}>
          <option value="mine">Assigned to me</option>
          <option value="all">Everyone</option>
          {(data?.reviewers || []).filter((r) => r.email !== data?.me).map((r) => <option key={r.email} value={r.email}>{r.name}</option>)}
        </select>
        <input style={{ ...input, width: "auto", minWidth: 160, marginLeft: "auto" }} placeholder="Search domain / candidate…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        <button style={chipBtn} onClick={() => load()} disabled={loading}>{loading ? "…" : "↻"}</button>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>Couldn&apos;t load: {err}</div>}
      {data && data.configured === false && <div style={{ margin: "12px 0" }} className="muted">The Owner Review queue isn&apos;t set up yet — run <code>scripts/owner_review.sql</code> on the main project.</div>}

      {cards.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "14px 0 8px" }}>
          <button style={{ ...chipBtn, opacity: clampedIdx <= 0 ? 0.4 : 1 }} disabled={clampedIdx <= 0} onClick={() => setIdx((i) => Math.max(0, i - 1))}>← Prev</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--navy-2,#4a5b66)" }}>{clampedIdx + 1} <span className="muted" style={{ fontWeight: 400 }}>of {cards.length}</span></span>
          <button style={{ ...chipBtn, opacity: clampedIdx >= cards.length - 1 ? 0.4 : 1 }} disabled={clampedIdx >= cards.length - 1} onClick={() => setIdx((i) => Math.min(cards.length - 1, i + 1))}>Next →</button>
        </div>
      )}

      {card ? (
        <ReviewCard key={card.id} card={card} reviewers={reviewers} onDone={afterAction} onRefresh={load}
          onSkip={() => setIdx((i) => Math.min(cards.length - 1, i + 1))} />
      ) : (
        !loading && !err && data?.configured !== false && (
          <div style={{ textAlign: "center", padding: "48px 12px" }} className="muted">
            <div style={{ fontSize: 40, marginBottom: 8 }}>✓</div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--navy,#254254)" }}>All caught up</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>{scope === "mine" ? "Nothing assigned to you in this view." : "No cards in this view."}</div>
          </div>
        )
      )}
    </main>
  );
}

function ReviewCard({ card, reviewers, onDone, onRefresh, onSkip }: { card: Card; reviewers: Reviewer[]; onDone: () => void; onRefresh: () => void; onSkip: () => void }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // Seed the edit form's first/last from explicit fields, else split candidate_name.
  const seedToks = (card.candidate_name || "").trim().split(/\s+/).filter(Boolean);
  const [f, setF] = useState({
    candidate_first_name: (card.candidate_first_name || seedToks[0] || ""),
    candidate_last_name: (card.candidate_last_name || (card.candidate_first_name ? "" : seedToks.slice(1).join(" ")) || ""),
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
      if (action === "reassign") { onRefresh(); return; }        // stay on the card; just reload assignment
      if (action === "resolve_name") { setMsg(j.resolved ? `✓ Pulled "${j.full}" from the thread` : "No fuller name found in the deal-mailbox headers"); onRefresh(); return; }
      if (action === "remine") { setMsg(j.remined ? "✓ Re-mined — updated from the email threads" : "Re-mined — no direct seller found in the threads"); onRefresh(); return; }
      if (action === "edit") { setEditing(false); onRefresh(); return; }
      onDone();                                                  // confirm / reject / skip → advance to next
    } catch (e) { setMsg(String((e as Error)?.message || e)); }
    finally { setBusy(null); }
  };

  const confHue = CONF_HUE[(card.confidence || "").toLowerCase()] || "#8a94a0";
  const noOwner = isNoOwner(card);
  const btnDismiss: CSSProperties = { ...btn, background: "#6b4a8a", color: "#fff", borderColor: "#6b4a8a", padding: "9px 20px", fontSize: 14 };

  return (
    <div style={{ border: "1px solid var(--line,#e3ddcf)", borderRadius: 14, padding: "20px 22px", background: "var(--paper,#fff)", boxShadow: "0 2px 10px rgba(20,25,30,0.05)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontWeight: 700, fontSize: 22, color: "var(--navy,#254254)" }}>{card.domain}</span>
        <span style={{ fontSize: 13, color: "var(--muted,#8a94a0)" }}>{[card.txn_date, card.txn_price].filter(Boolean).join(" · ")}</span>
      </div>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", margin: "10px 0 4px", alignItems: "center" }}>
        {card.channel && <Chip>{card.channel}</Chip>}
        {card.confidence && <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: confHue, borderRadius: 999, padding: "2px 10px", textTransform: "uppercase", letterSpacing: 0.3 }}>{card.confidence}</span>}
        {card.status !== "pending" && <span style={{ fontSize: 11, fontWeight: 700, color: "var(--navy-2,#4a5b66)", background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "2px 10px", textTransform: "uppercase" }}>{card.status}</span>}
      </div>

      {!editing ? (
        <div style={{ marginTop: 12, fontSize: 15 }}>
          {fullName(card) ? (
            <div style={{ fontWeight: 700, color: "var(--navy,#254254)", fontSize: 17 }}>{fullName(card)}</div>
          ) : <div className="muted" style={{ fontStyle: "italic" }}>No candidate seller named</div>}
          {card.candidate_email && <div style={{ color: "var(--navy-2,#4a5b66)", marginTop: 4 }}>✉ {card.candidate_email}</div>}
          {card.status !== "confirmed" && !editing && card.candidate_email && !(card.candidate_last_name || "").trim() && (
            <button style={{ ...btn, marginTop: 8, fontSize: 12.5, padding: "5px 11px" }} disabled={!!busy} onClick={() => act("resolve_name")} title="Read the seller's full name from the deal-mailbox thread headers">{busy === "resolve_name" ? "…" : "⤓ Pull full name from email"}</button>
          )}
          {card.candidate_phone && <div style={{ color: "var(--navy-2,#4a5b66)", marginTop: 3 }}>☎ {card.candidate_phone}</div>}
          {card.buyer_context && <div className="muted" style={{ marginTop: 8, fontSize: 13.5 }}>👤 Buyer/context: {card.buyer_context}</div>}
          {card.evidence && <div className="muted" style={{ marginTop: 6, fontSize: 13.5 }}>🔎 {card.evidence}</div>}
          {card.notes && <div className="muted" style={{ marginTop: 6, fontSize: 13.5 }}>📝 {card.notes}</div>}
          {noOwner && card.status === "pending" && (
            <div style={{ marginTop: 12, padding: "9px 12px", background: "#f5f0f8", border: "1px solid #e4d8ee", borderRadius: 9, fontSize: 13, color: "#5a4372" }}>
              ↳ Bought via a broker / marketplace / auction — there&apos;s likely <strong>no actual owner</strong> to record. We only log real sellers, so <strong>Dismiss</strong> this one (or Edit if a real seller IS in the thread).
            </div>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 14px" }}>
          <div><label style={L}>First name</label><input style={input} value={f.candidate_first_name} onChange={(e) => set("candidate_first_name", e.target.value)} placeholder="e.g. Marc" /></div>
          <div><label style={L}>Last name</label><input style={input} value={f.candidate_last_name} onChange={(e) => set("candidate_last_name", e.target.value)} placeholder="e.g. Hadfield" /></div>
          <div><label style={L}>Email</label><input style={input} value={f.candidate_email} onChange={(e) => set("candidate_email", e.target.value)} /></div>
          <div><label style={L}>Phone</label><input style={input} value={f.candidate_phone} onChange={(e) => set("candidate_phone", e.target.value)} /></div>
          <div><label style={L}>Channel</label><input style={input} value={f.channel} onChange={(e) => set("channel", e.target.value)} placeholder="Escrow.com / Direct / GoDaddy …" /></div>
          <div><label style={L}>Confidence</label><input style={input} value={f.confidence} onChange={(e) => set("confidence", e.target.value)} placeholder="high / medium / low" /></div>
          <div style={{ gridColumn: "1 / -1" }}><label style={L}>Evidence / note</label><textarea style={{ ...input, minHeight: 52, resize: "vertical" }} value={f.evidence} onChange={(e) => set("evidence", e.target.value)} /></div>
        </div>
      )}

      {msg && <div style={{ marginTop: 10, fontSize: 13, color: msg.startsWith("✓") ? "#2f7d4f" : "#a83265" }}>{msg}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 18, alignItems: "center" }}>
        {/* No-owner card (broker/marketplace/auction): Dismiss is the right call → make it primary. */}
        {card.status === "pending" && !editing && noOwner && <button style={btnDismiss} disabled={!!busy} onClick={() => act("dismiss")} title="No actual owner to log — bought via a broker / marketplace / auction. We only record real sellers.">⊘ Dismiss — no owner</button>}
        {card.status === "pending" && !editing && <button style={noOwner ? btn : btnGood} disabled={!!busy} onClick={() => act("confirm")}>{busy === "confirm" ? "…" : "✓ Confirm owner"}</button>}
        {editing && <button style={btnPrimary} disabled={!!busy} onClick={() => act("confirm")}>{busy === "confirm" ? "…" : "✓ Save & confirm"}</button>}
        <button style={btn} disabled={!!busy} onClick={() => { if (editing) act("edit"); else setEditing(true); }}>{editing ? (busy === "edit" ? "…" : "Save edits") : "✎ Edit"}</button>
        {editing && <button style={btn} onClick={() => setEditing(false)}>Cancel</button>}
        {card.status === "pending" && !editing && <button style={btn} disabled={!!busy} onClick={() => act("reject")} title="The surfaced candidate is wrong / mis-identified (e.g. it named the buyer as the seller)">✕ Reject</button>}
        {card.status === "pending" && !editing && <button style={btn} disabled={!!busy} onClick={() => act("remine")} title="Re-read the acquisition email threads for this domain and refresh the candidate seller — for a card that looks wrong or missed the real owner">{busy === "remine" ? "Re-mining…" : "↻ Re-mine from email"}</button>}
        {card.status === "pending" && !editing && <button style={btn} disabled={!!busy} onClick={onSkip} title="Decide later — just moves to the next card; this one stays pending in the queue">Skip →</button>}
        {card.status === "pending" && !editing && !noOwner && <button style={{ ...btn, color: "var(--muted,#8a94a0)" }} disabled={!!busy} onClick={() => act("dismiss")} title="No actual owner to log — set aside (reopenable). We only record real sellers.">⊘ Dismiss</button>}
        {card.status !== "pending" && <button style={btn} disabled={!!busy} onClick={() => act("reopen")}>↩ Reopen</button>}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line,#eee6d6)", display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
        <span className="muted">Assigned to:</span>
        <select style={{ ...input, width: "auto", padding: "5px 8px", fontSize: 13 }} value={card.assigned_to || ""} onChange={(e) => act("reassign", { assigned_to: e.target.value })} disabled={!!busy}>
          <option value="">Unassigned</option>
          {reviewers.map((r) => <option key={r.email} value={r.email}>{r.name}</option>)}
        </select>
        {card.deal_owner_id && <a href={`/deals/owners/${card.deal_owner_id}`} style={{ marginLeft: "auto", fontSize: 13, color: "var(--coral,#e2674a)", fontWeight: 600 }}>Owner record ↗</a>}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 11, fontWeight: 600, color: "var(--navy-2,#4a5b66)", background: "var(--paper-2,#f4f1ea)", borderRadius: 999, padding: "2px 10px" }}>{children}</span>;
}
