"use client";
import { useCallback, useEffect, useState } from "react";

type TargetRow = {
  keyword: string; target_url: string | null; intent: string | null; priority: number;
  position: number | null; prev_position: number | null; delta: number | null; status: string;
  impressions: number; clicks: number; ctr: number | null; volume: number | null;
  competitor_position: number | null; top_variant: string; top_url: string;
};
type MoverRow = { keyword: string; position: number | null; prev_position: number | null; delta: number; impressions: number; clicks: number };
type MoneyPage = { path: string; sessions: number; conversions: number };
type Metrics = { domain: string; dr: number | null; org_traffic: number; org_keywords: number; org_value_usd: number };
type Action = { id: string; title: string; detail: string | null; playbook: string | null; keyword: string | null; status: string; priority: number; owner_email: string | null };
type Report = {
  window: { from: string; to: string };
  headToHead: { ours: Metrics | null; competitor: Metrics | null };
  targets: TargetRow[]; movers: { gaining: MoverRow[]; losing: MoverRow[] };
  moneyPages: MoneyPage[]; actions: Action[]; snapshotWeeks: string[];
  sources: { gsc: boolean; ahrefs: boolean; ga: boolean };
};

const pos = (p: number | null) => (p == null ? "—" : p.toFixed(1));
const pct = (v: number | null) => (v == null ? "—" : (v * 100).toFixed(1) + "%");
const STATUS: Record<string, { label: string; bg: string; fg: string }> = {
  gaining: { label: "Gaining", bg: "#dcfce7", fg: "#166534" },
  losing: { label: "Losing", bg: "#fee2e2", fg: "#991b1b" },
  holding: { label: "Holding", bg: "#e5e7eb", fg: "#374151" },
  new: { label: "New", bg: "#dbeafe", fg: "#1e40af" },
  not_ranking: { label: "Not ranking", bg: "#f3f4f6", fg: "#6b7280" },
};

function Delta({ d }: { d: number | null }) {
  if (d == null) return <span className="muted">—</span>;
  if (d === 0) return <span className="muted">•</span>;
  const up = d > 0; // improved (position went down = gained distance)
  return <span style={{ color: up ? "#166534" : "#991b1b", fontWeight: 700 }}>{up ? "▲" : "▼"}{Math.abs(d).toFixed(1)}</span>;
}

// Minimal, safe markdown → HTML for the action drill-downs (headings, bold, inline
// code, fenced code blocks, links, lists). Content is escaped before formatting.
function esc(s: string) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inlineMd(s: string) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code style="background:#eee;padding:1px 4px;border-radius:4px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}
function renderMd(md: string): string {
  const lines = (md || "").replace(/\r/g, "").split("\n");
  const out: string[] = []; let i = 0; let list: null | "ul" | "ol" = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      closeList(); const body: string[] = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push(`<pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:8px;overflow-x:auto;font-size:12px;line-height:1.4"><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 2, 6); out.push(`<h${lvl} style="margin:14px 0 4px;font-size:${lvl === 3 ? 15 : 14}px">${inlineMd(h[2])}</h${lvl}>`); i++; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/); const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ol) { if (list !== "ol") { closeList(); list = "ol"; out.push('<ol style="margin:4px 0 6px 20px">'); } out.push(`<li>${inlineMd(ol[1])}</li>`); i++; continue; }
    if (ul) { if (list !== "ul") { closeList(); list = "ul"; out.push('<ul style="margin:4px 0 6px 20px">'); } out.push(`<li>${inlineMd(ul[1])}</li>`); i++; continue; }
    if (!line.trim()) { closeList(); i++; continue; }
    closeList(); out.push(`<p style="margin:6px 0">${inlineMd(line)}</p>`); i++;
  }
  closeList(); return out.join("");
}

export default function SeoClient() {
  const [rep, setRep] = useState<Report | null>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [newAction, setNewAction] = useState({ title: "", keyword: "" });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const load = useCallback(async () => {
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/admin/seo", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Failed (${r.status})`);
      setRep(d.report);
    } catch (e) { setErr(String((e as Error).message)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body: unknown, label: string) => {
    setBusy(label);
    try {
      const r = await fetch("/api/admin/seo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Failed");
      await load();
    } catch (e) { setErr(String((e as Error).message)); } finally { setBusy(""); }
  };
  // Action mutations are OPTIMISTIC and never rebuild the (slow, ~25s) report — they
  // just patch local state + POST in the background, so checking a box is instant.
  const patchActions = (fn: (arr: Action[]) => Action[]) => setRep((prev) => (prev ? { ...prev, actions: fn(prev.actions) } : prev));
  const toggleDone = async (a: Action) => {
    const status = a.status === "done" ? "todo" : "done";
    patchActions((arr) => arr.map((x) => (x.id === a.id ? { ...x, status } : x)));
    try {
      const r = await fetch("/api/admin/seo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "update_action", item: { id: a.id, status } }) });
      if (!r.ok) throw new Error();
    } catch { patchActions((arr) => arr.map((x) => (x.id === a.id ? { ...x, status: a.status } : x))); setErr("Couldn't save that change — try again."); }
  };
  const addAction = async () => {
    const title = newAction.title.trim(); if (!title) return;
    const keyword = newAction.keyword.trim() || null;
    setNewAction({ title: "", keyword: "" });
    try {
      const r = await fetch("/api/admin/seo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "add_action", item: { title, keyword } }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Failed");
      if (d.item) patchActions((arr) => [...arr, d.item]); else load();
    } catch (e) { setErr(String((e as Error).message)); }
  };

  const actionRow = (a: Action) => {
    const isOpen = open.has(a.id);
    const hasKit = !!(a.playbook && a.playbook.trim());
    const done = a.status === "done";
    return (
      <li key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid #f4f4f4", opacity: done ? 0.55 : 1 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <input type="checkbox" checked={done} onChange={() => toggleDone(a)} title={done ? "Mark as to-do" : "Mark done"} style={{ marginTop: 3, width: 18, height: 18, cursor: "pointer", flex: "0 0 auto" }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div onClick={hasKit ? () => toggle(a.id) : undefined} style={{ cursor: hasKit ? "pointer" : "default", fontWeight: 600, textDecoration: done ? "line-through" : "none" }}>
              {hasKit ? <span style={{ color: "#0d9488" }}>{isOpen ? "▾" : "▸"} </span> : null}{a.title}
              {a.keyword ? <span className="muted" style={{ fontWeight: 400 }}> · {a.keyword}</span> : null}
              {hasKit ? <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}> · {isOpen ? "hide" : "build kit"}</span> : null}
            </div>
            {a.detail ? <div className="muted" style={{ fontSize: 12 }}>{a.detail}</div> : null}
            {hasKit && isOpen ? <div style={{ marginTop: 8, padding: "12px 16px", background: "#fff", border: "1px solid var(--line,#e5e7eb)", borderRadius: 8, fontSize: 14, lineHeight: 1.5, overflowX: "auto" }} dangerouslySetInnerHTML={{ __html: renderMd(a.playbook || "") }} /> : null}
          </div>
        </div>
      </li>
    );
  };

  const h2h = rep?.headToHead;
  const openActions = (rep?.actions || []).filter((a) => a.status !== "done");
  const doneActions = (rep?.actions || []).filter((a) => a.status === "done");

  return (
    <main data-wide-page>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ fontSize: "1.35rem", margin: 0 }}>SEO — high-intent rankings</h1>
        <span className="muted">{rep ? `${rep.window.from} → ${rep.window.to}` : ""}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button onClick={load} disabled={loading}>↻ Refresh</button>
          <button onClick={() => post({ action: "snapshot" }, "snap")} disabled={!!busy} title="Save this week's positions for week-over-week tracking">📸 Snapshot week</button>
        </div>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>Tracking where we rank for the money terms, which are gaining/losing distance week-over-week, and the actions to close the gap vs {h2h?.competitor?.domain || "the competitor"}.</p>
      {err && <p style={{ color: "#991b1b" }}>⚠️ {err}</p>}
      {loading && !rep && <p className="muted">Loading GSC + Ahrefs + GA…</p>}
      {rep && (
        <>
          {/* Head-to-head */}
          {(h2h?.ours || h2h?.competitor) && (
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", margin: "10px 0 18px" }}>
              {([["Us (snagged.com)", h2h?.ours], [h2h?.competitor?.domain || "Competitor", h2h?.competitor]] as [string, Metrics | null][]).map(([label, m]) => (
                <div key={label} style={{ border: "1px solid var(--line,#e5e7eb)", borderRadius: 10, padding: "10px 14px", minWidth: 210 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>{label}</div>
                  <div className="muted" style={{ fontSize: 13, lineHeight: 1.7 }}>
                    DR <b>{m?.dr ?? "—"}</b> · organic <b>{m ? m.org_traffic.toLocaleString() : "—"}</b>/mo<br />
                    value <b>${m ? Math.round(m.org_value_usd).toLocaleString() : "—"}</b>/mo · <b>{m ? m.org_keywords.toLocaleString() : "—"}</b> keywords
                  </div>
                </div>
              ))}
            </div>
          )}
          {!rep.sources.ahrefs && <p className="muted" style={{ fontSize: 13 }}>Ahrefs not configured — volume + competitor columns are blank (set <code>AHREF_API_KEY</code>).</p>}

          {/* Money terms */}
          <h2 style={{ fontSize: "1.05rem", marginBottom: 6 }}>Money terms</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead><tr style={{ textAlign: "left", color: "#777", borderBottom: "1px solid var(--line,#e5e7eb)" }}>
                {["Keyword", "Page", "Position", "WoW", "Status", "Impr", "Clicks", "CTR", "Volume", "Competitor"].map((h, i) => (
                  <th key={h} style={{ padding: "6px 10px", textAlign: i >= 2 ? "right" : "left" }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {rep.targets.map((t) => {
                  const s = STATUS[t.status] || STATUS.holding;
                  return (
                    <tr key={t.keyword} style={{ borderBottom: "1px solid #f1f1f1" }}>
                      <td style={{ padding: "6px 10px", fontWeight: 600 }}>{t.keyword}{t.top_variant && t.top_variant.toLowerCase() !== t.keyword.toLowerCase() ? <div className="muted" style={{ fontSize: 12 }}>top: {t.top_variant}</div> : null}</td>
                      <td style={{ padding: "6px 10px" }}>{t.target_url ? <a href={t.target_url} target="_blank" rel="noreferrer">{t.target_url.replace(/^https?:\/\/[^/]+/, "")}</a> : <span className="muted">—</span>}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700 }}>{pos(t.position)}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}><Delta d={t.delta} /></td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}><span style={{ background: s.bg, color: s.fg, borderRadius: 999, padding: "2px 9px", fontSize: 12, fontWeight: 700, whiteSpace: "nowrap" }}>{s.label}</span></td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>{t.impressions.toLocaleString()}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>{t.clicks.toLocaleString()}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>{pct(t.ctr)}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>{t.volume?.toLocaleString() ?? "—"}</td>
                      <td style={{ padding: "6px 10px", textAlign: "right" }}>{pos(t.competitor_position)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!rep.snapshotWeeks.length && <p className="muted" style={{ fontSize: 13 }}>No weekly snapshots yet — WoW deltas appear after the first snapshot (click “Snapshot week”, or the Monday cron).</p>}

          {/* Movers */}
          {(rep.movers.gaining.length > 0 || rep.movers.losing.length > 0) && (
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", margin: "20px 0" }}>
              {([["▲ Gaining distance", rep.movers.gaining], ["▼ Losing distance", rep.movers.losing]] as [string, MoverRow[]][]).map(([label, rows]) => (
                <div key={label} style={{ flex: "1 1 320px", minWidth: 300 }}>
                  <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>{label} <span className="muted">(all queries, WoW)</span></h3>
                  <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                    <tbody>{rows.map((m) => (
                      <tr key={m.keyword} style={{ borderBottom: "1px solid #f4f4f4" }}>
                        <td style={{ padding: "4px 8px" }}>{m.keyword}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right" }}>pos {pos(m.position)}</td>
                        <td style={{ padding: "4px 8px", textAlign: "right" }}><Delta d={m.delta} /></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ))}
            </div>
          )}

          {/* Money-page performance */}
          {rep.moneyPages.length > 0 && (
            <div style={{ margin: "18px 0" }}>
              <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Money-page performance <span className="muted">(GA organic, 30d)</span></h3>
              <table style={{ borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr className="muted" style={{ textAlign: "left" }}><th style={{ padding: "4px 12px 4px 0" }}>Page</th><th style={{ padding: "4px 12px", textAlign: "right" }}>Organic sessions</th><th style={{ padding: "4px 12px", textAlign: "right" }}>Conversions</th></tr></thead>
                <tbody>{rep.moneyPages.map((p) => (
                  <tr key={p.path}><td style={{ padding: "4px 12px 4px 0" }}>{p.path}</td><td style={{ padding: "4px 12px", textAlign: "right" }}>{p.sessions.toLocaleString()}</td><td style={{ padding: "4px 12px", textAlign: "right" }}>{p.conversions.toLocaleString()}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}

          {/* Action loop */}
          <h2 style={{ fontSize: "1.05rem", margin: "22px 0 6px" }}>This week&apos;s actions</h2>
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            <input value={newAction.title} onChange={(e) => setNewAction((s) => ({ ...s, title: e.target.value }))} placeholder="Add a next step…" style={{ flex: "1 1 320px", padding: "6px 10px" }} onKeyDown={(e) => e.key === "Enter" && addAction()} />
            <input value={newAction.keyword} onChange={(e) => setNewAction((s) => ({ ...s, keyword: e.target.value }))} placeholder="keyword (optional)" style={{ width: 180, padding: "6px 10px" }} />
            <button onClick={addAction} disabled={busy === "add" || !newAction.title.trim()}>＋ Add</button>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {openActions.map((a) => actionRow(a))}
            {doneActions.length > 0 && <li style={{ margin: "12px 0 2px" }} className="muted">Completed ({doneActions.length})</li>}
            {doneActions.map((a) => actionRow(a))}
          </ul>
        </>
      )}
    </main>
  );
}
