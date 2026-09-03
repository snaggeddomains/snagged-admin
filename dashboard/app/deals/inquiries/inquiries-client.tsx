"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { BUDGET_BANDS, normalizeBudget } from "@/lib/deals/stages";

type Inquiry = {
  leadKey: string;
  name: string | null;
  email: string | null;
  companyDomain: string | null;
  domains: string[];
  requested: string | null;
  intent: string | null;
  isBuySide: boolean;
  budget: string | null;
  heardAbout: string | null;
  message: string | null;
  location: string | null;
  tier: string | null;
  routeTo: string | null;
  suggestedAssigneeEmail: string | null;
  reasons: string[];
  vip: { band: string | null; followers: number | null } | null;
  company: { name: string | null; funding: string | null; employees: number | null; revenue: string | null } | null;
  status: string | null;
  dossierUrl: string;
  createdAt: string | null;
  updatedAt: string | null;
  dismissed: boolean;
};
type Meta = { assignees: { name: string; email: string }[]; sources: string[] };
type ListResp = { ok: boolean; configured: boolean; inquiries: Inquiry[]; meta: Meta; error?: string };
type ConvertResult = { ok: boolean; created?: boolean; url?: string; error?: string };

const card: CSSProperties = { border: "1px solid var(--line, #e3ddcf)", borderRadius: 12, padding: "14px 16px", marginBottom: 12, background: "var(--paper, #fff)" };
const chip: CSSProperties = { display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: "var(--paper-2, #f4f1ea)", color: "var(--navy, #254254)", marginRight: 6, marginBottom: 4 };
const btnPrimary: CSSProperties = { padding: "7px 14px", borderRadius: 8, background: "var(--coral, #e2674a)", color: "#fff", border: "1px solid var(--coral, #e2674a)", fontSize: 13, fontWeight: 700, cursor: "pointer" };
const btnGhost: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "transparent", color: "var(--navy, #254254)", border: "1px solid var(--line, #e3ddcf)", fontSize: 13, fontWeight: 600, cursor: "pointer" };
const fieldLabel: CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "var(--navy-2, #4a5b66)", margin: "10px 0 3px" };
const input: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line, #e3ddcf)", fontSize: 14, boxSizing: "border-box" };

function tierPill(tier: string | null) {
  const t = (tier || "").toLowerCase();
  const map: Record<string, { label: string; bg: string; fg: string }> = {
    vip: { label: "VIP", bg: "#fbe0ea", fg: "#a83265" },
    notable: { label: "Notable", bg: "#fdf0d2", fg: "#946200" },
    standard: { label: "Standard", bg: "#e6edf2", fg: "#254254" },
  };
  const s = map[t];
  if (!s) return null;
  return <span style={{ ...chip, background: s.bg, color: s.fg }}>{s.label}</span>;
}

export default function InquiriesClient() {
  const [data, setData] = useState<ListResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Inquiry | null>(null);
  const [results, setResults] = useState<Record<string, ConvertResult>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const p = new URLSearchParams();
      if (showAll) p.set("all", "1");
      if (showDismissed) p.set("dismissed", "1");
      if (q) p.set("q", q);
      const res = await fetch(`/api/admin/inquiries?${p}`);
      const j = (await res.json()) as ListResp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [showAll, showDismissed, q]);

  const dismiss = async (leadKey: string, on: boolean) => {
    if (on && !window.confirm("Ignore this inquiry? It'll be hidden from the queue (spam/test). You can restore it via “Show dismissed.”")) return;
    await fetch("/api/admin/inquiries", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: on ? "dismiss" : "undismiss", leadKey }) });
    load();
  };

  useEffect(() => { load(); }, [load]);

  const meta = data?.meta || { assignees: [], sources: [] };
  const inquiries = data?.inquiries || [];

  return (
    <main style={{ maxWidth: "var(--maxw, 1080px)", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Buy-Side Inquiries</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>Inbound contact-form inquiries, enriched and triaged. Convert a real buy-side lead into a deal.</p>
        </div>
        <button style={btnGhost} onClick={() => load()} disabled={loading}>{loading ? "Loading…" : "↻ Refresh"}</button>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", margin: "14px 0", flexWrap: "wrap" }}>
        <input style={{ ...input, width: 240 }} placeholder="Search name / email / domain…" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
        <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show sell-side too
        </label>
        <label style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
          Show dismissed
        </label>
      </div>

      {err && <div style={{ ...card, borderColor: "#e2674a", color: "#a83265" }}>Couldn&apos;t load inquiries: {err}</div>}
      {data && !data.configured && <div style={card}>The leads database isn&apos;t configured on this server.</div>}
      {data && data.configured && !inquiries.length && !loading && (
        <div style={card}>No {showAll ? "" : "buy-side "}inquiries yet. New contact-form submissions to inquiry@snagged.com appear here once the intake is wired.</div>
      )}

      {inquiries.map((i) => {
        const r = results[i.leadKey];
        return (
          <div key={i.leadKey} style={card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>
                  {i.name || i.email || "Inquiry"} {tierPill(i.tier)}
                  {!i.isBuySide && <span style={{ ...chip, background: "#eee", color: "#666" }}>sell-side</span>}
                </div>
                {i.email && <div className="muted" style={{ fontSize: 13 }}>{i.email}{i.location ? ` · ${i.location}` : ""}</div>}
                <div style={{ marginTop: 8 }}>
                  {i.domains.length
                    ? i.domains.map((d) => <span key={d} style={chip}>{d}</span>)
                    : i.requested && <span style={{ ...chip, background: "#fdf0d2", color: "#946200" }} title="Not a domain — set the target on convert">“{i.requested}” · not a domain</span>}
                </div>
                <div style={{ fontSize: 13, marginTop: 6, color: "var(--navy-2, #4a5b66)" }}>
                  {i.intent && <span style={{ marginRight: 12 }}><strong>Intent:</strong> {i.intent}</span>}
                  {i.budget && <span style={{ marginRight: 12 }}><strong>Budget:</strong> {i.budget}</span>}
                  {i.heardAbout && <span style={{ marginRight: 12 }}><strong>Heard about:</strong> {i.heardAbout}</span>}
                  {i.routeTo && <span><strong>Route:</strong> {i.routeTo}</span>}
                </div>
                {i.vip && (i.vip.band || i.vip.followers) && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>👤 {i.vip.band ? `${i.vip.band}` : ""}{i.vip.followers ? ` · ${Math.round(i.vip.followers / 1000)}K followers` : ""}</div>
                )}
                {i.company && (
                  <div style={{ fontSize: 13, marginTop: 4 }}>🏢 {i.company.name}{i.company.funding ? ` · raised ${i.company.funding}` : ""}{i.company.employees ? ` · ${i.company.employees.toLocaleString()} employees` : ""}{i.company.revenue ? ` · ${i.company.revenue} rev` : ""}</div>
                )}
                {i.message && <div style={{ fontSize: 13, marginTop: 6, fontStyle: "italic", color: "var(--navy-2, #4a5b66)" }}>&ldquo;{i.message.slice(0, 220)}&rdquo;</div>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end", flex: "none" }}>
                {/* Same-window nav (same-origin app.snagged.com) — the desktop app spawns a
                    new window on target=_blank, losing the session. */}
                <a href={i.dossierUrl} style={{ ...btnGhost, textDecoration: "none" }}>Dossier ↗</a>
                {r?.ok ? (
                  <a href={r.url} style={{ fontSize: 13, fontWeight: 700, color: "#1f7a5a" }}>
                    ✓ {r.created ? "Added" : "In deal"} — open ↗
                  </a>
                ) : (
                  <button style={btnPrimary} onClick={() => setActive(i)}>➕ Add to deal</button>
                )}
                {r && !r.ok && <div style={{ fontSize: 12, color: "#a83265" }}>{r.error}</div>}
                {i.dismissed
                  ? <button style={{ ...btnGhost, fontSize: 12, padding: "3px 9px" }} onClick={() => dismiss(i.leadKey, false)}>Restore</button>
                  : <button style={{ ...btnGhost, fontSize: 12, padding: "3px 9px", color: "#8a94a0" }} onClick={() => dismiss(i.leadKey, true)}>Dismiss</button>}
              </div>
            </div>
          </div>
        );
      })}

      {active && (
        <ConvertModal
          inquiry={active}
          meta={meta}
          onClose={() => setActive(null)}
          onDone={(res) => {
            const key = active.leadKey;
            setResults((m) => ({ ...m, [key]: res }));
            setActive(null);
            if (res.ok) {
              // Converting resolves the inquiry (the server auto-dismisses it) — drop it from
              // the queue right away so it "auto-completes" instead of lingering as "Added",
              // then reload to reconcile (unless "Show dismissed" is on, where it should stay).
              if (!showDismissed) setData((d) => (d ? { ...d, inquiries: d.inquiries.filter((i) => i.leadKey !== key) } : d));
              load();
            }
          }}
        />
      )}
    </main>
  );
}

function ConvertModal({ inquiry, meta, onClose, onDone }: { inquiry: Inquiry; meta: Meta; onClose: () => void; onDone: (r: ConvertResult) => void }) {
  const sources = meta.sources.length ? meta.sources : ["Website form"];
  const defaultSource = useMemo(() => sources.find((s) => /website form/i.test(s)) || sources.find((s) => /form/i.test(s)) || sources[0], [sources]);
  const [domain, setDomain] = useState(inquiry.domains[0] || "");
  const [source, setSource] = useState(defaultSource);
  const [assignee, setAssignee] = useState(
    inquiry.suggestedAssigneeEmail && meta.assignees.some((a) => a.email.toLowerCase() === inquiry.suggestedAssigneeEmail!.toLowerCase())
      ? inquiry.suggestedAssigneeEmail : "",
  );
  const [priority, setPriority] = useState("");
  const [buyerName, setBuyerName] = useState(inquiry.name || "");
  const [buyerEmail, setBuyerEmail] = useState(inquiry.email || "");
  const [budget, setBudget] = useState(normalizeBudget(inquiry.budget) || "");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!source) { setError("Pick a source."); return; }
    setBusy(true);
    setError(null);
    // Carry the buyer's own inquiry context onto the deal so the assignee has the full picture
    // (the message is the richest signal — why they want it, their situation) — not just the
    // structured fields. Lands in the deal's Notes.
    const inquiryNotes = [
      inquiry.message ? `📩 Buyer's inquiry:\n${inquiry.message.trim()}` : "",
      inquiry.location ? `Location: ${inquiry.location}` : "",
    ].filter(Boolean).join("\n\n") || undefined;
    try {
      const res = await fetch("/api/admin/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          source,
          assigneeEmail: assignee || undefined,
          priority: priority || undefined,
          buyerName: buyerName.trim() || undefined,
          buyerEmail: buyerEmail.trim() || undefined,
          budgetRange: budget || undefined,
          heardAbout: inquiry.heardAbout || undefined,
          intent: inquiry.intent || undefined,
          notes: inquiryNotes,
          comment: comment.trim() || undefined,
          additionalDomains: inquiry.domains.slice(1).join(", ") || undefined,
          orgName: inquiry.company?.name || undefined,
          leadKey: inquiry.leadKey || undefined,
        }),
      });
      const j = (await res.json()) as ConvertResult;
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onDone(j);
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setBusy(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }} onClick={onClose}>
      <div style={{ background: "var(--paper, #fff)", borderRadius: 14, padding: 20, width: "min(460px, 100%)", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ fontSize: "1.1rem", margin: 0 }}>Add to deal</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>{inquiry.name || inquiry.email}</p>

        <label style={fieldLabel}>Target domain</label>
        {inquiry.domains.length > 1 ? (
          <select style={input} value={domain} onChange={(e) => setDomain(e.target.value)}>
            {inquiry.domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        ) : (
          <input style={input} value={domain} onChange={(e) => setDomain(e.target.value)} />
        )}
        {inquiry.domains.length > 1 && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>The other {inquiry.domains.length - 1} attach as additional domains.</div>}

        <label style={fieldLabel}>Source / channel</label>
        <select style={input} value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>

        <label style={fieldLabel}>Assign to</label>
        <select style={input} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Unassigned / Inbox</option>
          {meta.assignees.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
        </select>

        <label style={fieldLabel}>Priority</label>
        <select style={input} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">—</option>
          <option value="Top">Top</option>
          <option value="High">High</option>
          <option value="Normal">Normal</option>
          <option value="Low">Low</option>
        </select>

        <label style={fieldLabel}>Client / buyer name</label>
        <input style={input} value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Optional" />

        <label style={fieldLabel}>Client / buyer email</label>
        <input style={input} type="email" value={buyerEmail} onChange={(e) => setBuyerEmail(e.target.value)} placeholder="Optional" />

        <label style={fieldLabel}>Budget range</label>
        <select style={input} value={budget} onChange={(e) => setBudget(e.target.value)}>
          <option value="">—</option>
          {BUDGET_BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>

        <label style={fieldLabel}>Comment (optional)</label>
        <textarea
          style={{ ...input, minHeight: 64, resize: "vertical", fontFamily: "inherit" }}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Context for whoever picks this up — added as the first note on the deal"
        />

        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button style={btnGhost} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={btnPrimary} onClick={submit} disabled={busy || !domain}>{busy ? "Adding…" : "Create deal"}</button>
        </div>
      </div>
    </div>
  );
}
