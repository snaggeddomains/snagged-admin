"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Opp = {
  id: string; source_id: string; source_title: string | null; source_slug: string | null;
  target_id: string; target_title: string | null; target_slug: string | null;
  anchor: string | null; context: string | null; rationale: string | null; score: number | null;
  status: string; feedback: "up" | "down" | null;
  kind: string | null; new_sentence: string | null;
};
type Run = { id: string; status: string; started_at: string; finished_at: string | null; posts: number | null; opportunities: number | null; error: string | null };
type Resp = { ok: boolean; configured: boolean; run: Run | null; opportunities: Opp[]; error?: string; canInsert?: boolean; insertedCount?: number };

const CORAL = "var(--coral-deep, #c0492f)";
const BTN: CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer", whiteSpace: "nowrap" };
const BTNP: CSSProperties = { ...BTN, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const CTL: CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)" };
const cell: CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--line,#eee)", verticalAlign: "top" };
const th: CSSProperties = { ...cell, textAlign: "left", color: "var(--muted,#888)", fontWeight: 700, whiteSpace: "nowrap", background: "var(--paper-2,#f7f5ef)" };
const postUrl = (slug: string | null) => slug ? `https://www.snagged.com/post/${slug}` : null;
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "";

// A post title that truncates but keeps a visible ↗ open-link (both title + arrow open the post),
// so you can cross-check the source and target side by side.
function PostLink({ title, slug, color, prefix }: { title: string | null; slug: string | null; color: string; prefix?: string }) {
  const url = postUrl(slug);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, maxWidth: 240 }}>
      {url
        ? <a href={url} target="_blank" rel="noreferrer" title={title || "Open post"} style={{ fontWeight: 600, color, textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prefix}{title || "—"}</a>
        : <span style={{ fontWeight: 600, color, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prefix}{title || "—"}</span>}
      {url && <a href={url} target="_blank" rel="noreferrer" title="Open post ↗" style={{ flex: "none", color: "var(--muted,#888)", textDecoration: "none", fontSize: 12.5 }}>↗</a>}
    </div>
  );
}

// Render a proposed new sentence with the anchor portion highlighted (add_sentence opportunities).
function SentenceWithAnchor({ sentence, anchor }: { sentence: string; anchor: string | null }) {
  const a = (anchor || "").trim();
  const i = a ? sentence.toLowerCase().indexOf(a.toLowerCase()) : -1;
  if (i < 0) return <span style={{ fontStyle: "italic" }}>{sentence}</span>;
  return (
    <span style={{ fontStyle: "italic" }}>
      {sentence.slice(0, i)}
      <span style={{ background: "#fdf3d8", borderRadius: 4, padding: "1px 5px", fontStyle: "normal", fontWeight: 600 }}>{sentence.slice(i, i + a.length)}</span>
      {sentence.slice(i + a.length)}
    </span>
  );
}

// The "Anchor text" cell: an existing-phrase link (kind=anchor) or a proposed new sentence
// to insert (kind=add_sentence — shown with a badge + where it goes).
function AnchorCell({ o }: { o: Opp }) {
  if (o.kind === "add_sentence") {
    return (
      <div style={{ display: "grid", gap: 4 }}>
        <span style={{ display: "inline-block", width: "fit-content", fontSize: 10.5, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase", color: "#8a5a00", background: "#fbe7c2", borderRadius: 999, padding: "1px 7px" }}>＋ Add sentence</span>
        <span style={{ color: "var(--navy,#254254)" }}><SentenceWithAnchor sentence={o.new_sentence || ""} anchor={o.anchor} /></span>
        {o.context && <span className="muted" style={{ fontSize: 11.5 }}>after: “{o.context}”</span>}
      </div>
    );
  }
  return <span style={{ background: "#fdf3d8", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>{o.anchor || "—"}</span>;
}

export default function CrosslinksView() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [insertedThisSession, setInsertedThisSession] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/admin/content/crosslinks", { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const analyze = async () => {
    if (!confirm("Analyze the whole blog for cross-link opportunities? This runs an AI pass over every post and can take a few minutes.")) return;
    setAnalyzing(true); setErr(null);
    try {
      const res = await fetch("/api/admin/content/crosslinks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "analyze" }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      await load();
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setAnalyzing(false); }
  };

  // Insert the link into the actual post. publish=false stages it in Webflow (review/publish later);
  // publish=true also pushes it live. add_sentence adds a new sentence; anchor wraps an existing phrase.
  const insert = async (o: Opp, publish: boolean) => {
    const what = o.kind === "add_sentence" ? "\n\nThis ADDS a new sentence to the post to host the link." : "";
    const msg = publish
      ? `Insert this link into “${o.source_title}” and PUBLISH it live?${what}`
      : `Insert this link into “${o.source_title}” as a staged draft in Webflow (review & publish later)?${what}`;
    if (!confirm(msg)) return;
    setBusyId(o.id); setErr(null); setNote(null);
    try {
      const res = await fetch("/api/admin/content/crosslinks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "insert", id: o.id, publish }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) {
        if (j.dismissed) { // can never be auto-inserted → remove it quietly rather than error
          setData((d) => d ? { ...d, opportunities: d.opportunities.filter((x) => x.id !== o.id) } : d);
          setNote("Hidden — not placeable (already a link elsewhere / heading).");
          return;
        }
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      setData((d) => d ? { ...d, opportunities: d.opportunities.filter((x) => x.id !== o.id) } : d); // done → off the active screen
      setInsertedThisSession((n) => n + 1);
      if (j.repointed) setNote("↪ Repointed an existing link to our post.");
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBusyId(null); }
  };

  const toggleOne = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Insert every selected row in one request (grouped server-side by post). publish pushes them live.
  const bulkInsert = async (publish: boolean, ids: string[]) => {
    if (!ids.length) return;
    if (!confirm(`Insert ${ids.length} link${ids.length > 1 ? "s" : ""} ${publish ? "and PUBLISH them live" : "as staged drafts in Webflow"}?`)) return;
    setBulkBusy(true); setErr(null); setNote(null);
    try {
      const res = await fetch("/api/admin/content/crosslinks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "insert_bulk", ids, publish }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      const results: { id: string; ok: boolean; error?: string; dismissed?: boolean; repointed?: boolean }[] = j.results || [];
      const okIds = new Set(results.filter((r) => r.ok).map((r) => r.id));
      const hiddenIds = new Set(results.filter((r) => !r.ok && r.dismissed).map((r) => r.id)); // unplaceable → drop from list
      const fails = results.filter((r) => !r.ok && !r.dismissed);                                // transient errors → report
      const repointed = results.filter((r) => r.ok && r.repointed).length;
      setData((d) => d ? { ...d, opportunities: d.opportunities.filter((x) => !hiddenIds.has(x.id) && !okIds.has(x.id)) } : d);
      setSelected(new Set());
      setInsertedThisSession((n) => n + okIds.size);
      setNote(`${okIds.size} inserted${repointed ? ` (${repointed} repointed)` : ""}${hiddenIds.size ? ` · ${hiddenIds.size} not placeable (hidden)` : ""}`);
      if (fails.length) setErr(`${fails.length} failed — ${[...new Set(fails.map((f) => f.error))].slice(0, 2).join("; ")}`);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setBulkBusy(false); }
  };

  // Feedback: up = boost, down = remove (suppressed going forward). Dismiss = hide this one.
  const act = async (o: Opp, kind: "up" | "down" | "dismiss") => {
    setBusyId(o.id);
    try {
      const body = kind === "dismiss"
        ? { action: "dismiss", id: o.id }
        : { action: "feedback", source_id: o.source_id, target_id: o.target_id, rating: kind };
      await fetch("/api/admin/content/crosslinks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setData((d) => {
        if (!d) return d;
        if (kind === "up") return { ...d, opportunities: d.opportunities.map((x) => x.id === o.id ? { ...x, feedback: "up" } : x) };
        return { ...d, opportunities: d.opportunities.filter((x) => x.id !== o.id) }; // down / dismiss → remove
      });
    } finally { setBusyId(null); }
  };

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.opportunities || []).filter((o) =>
      o.status !== "inserted" &&  // done rows drop off the active screen
      (Number(o.score) || 0) >= minScore &&
      (!t || `${o.source_title} ${o.target_title} ${o.anchor} ${o.new_sentence} ${o.rationale}`.toLowerCase().includes(t)));
  }, [data, q, minScore]);

  const run = data?.run;
  const scoreColor = (s: number) => s >= 75 ? "#1f7a5a" : s >= 55 ? "#946200" : "#7a6f63";
  const canInsert = !!data?.canInsert;
  const selectable = rows.filter((o) => o.status !== "inserted");             // inserted rows aren't re-selectable
  const allSelected = selectable.length > 0 && selectable.every((o) => selected.has(o.id));
  const selectedIds = selectable.filter((o) => selected.has(o.id)).map((o) => o.id);
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable.map((o) => o.id)));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "6px 0 10px" }}>
        <button style={BTNP} onClick={analyze} disabled={analyzing}>{analyzing ? "Analyzing… (a few min)" : (run ? "↻ Re-analyze" : "Analyze the blog")}</button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {run ? <>Last analyzed {when(run.finished_at || run.started_at)} · {run.opportunities ?? 0} opportunities across {run.posts ?? 0} posts{run.status !== "done" ? ` · ${run.status}` : ""}{((data?.insertedCount ?? 0) + insertedThisSession) > 0 ? ` · ✓ ${(data?.insertedCount ?? 0) + insertedThisSession} inserted` : ""}</> : "Not analyzed yet."}
        </span>
      </div>
      <p className="section-blurb" style={{ marginTop: 0 }}>
        Stack-ranked internal-link opportunities — where one post should link to another, for SEO. Most link an existing phrase; a <b style={{ color: "#8a5a00" }}>＋ Add sentence</b> row proposes a new sentence to host the link when the best spot would otherwise land on a heading (we never link headings). 👍 super-relevant / 👎 not relevant trains future runs; 👎 removes it. Highly-relevant only.
      </p>

      {(data?.opportunities?.length ?? 0) > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
          <input style={{ ...CTL, minWidth: 200 }} placeholder="Search posts / anchors…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select style={CTL} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} title="Minimum relevance score">
            <option value={0}>All scores</option><option value={55}>Score ≥ 55</option><option value={70}>Score ≥ 70</option><option value={85}>Score ≥ 85</option>
          </select>
          <span className="muted" style={{ fontSize: 12 }}>{rows.length} shown</span>
        </div>
      )}

      {canInsert && selectedIds.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "8px 0", padding: "8px 10px", background: "#f2f8f4", border: "1px solid #cfe6d8", borderRadius: 8 }}>
          <b style={{ fontSize: 13, color: "var(--navy,#254254)" }}>{selectedIds.length} selected</b>
          <button style={{ ...BTN, padding: "4px 10px" }} disabled={bulkBusy} onClick={() => bulkInsert(false, selectedIds)}>{bulkBusy ? "Working…" : "Insert staged"}</button>
          <button style={{ ...BTNP, padding: "4px 10px" }} disabled={bulkBusy} onClick={() => bulkInsert(true, selectedIds)}>{bulkBusy ? "Working…" : "＋ Insert & publish live"}</button>
          <button style={{ ...BTN, padding: "4px 10px" }} disabled={bulkBusy} onClick={() => setSelected(new Set())}>Clear</button>
          <span className="muted" style={{ fontSize: 11.5 }}>Already-linked rows resolve automatically; unplaceable ones are skipped with a reason.</span>
        </div>
      )}

      {note && <p style={{ color: "#1f7a5a", fontSize: 12.5, margin: "6px 0" }}>{note}</p>}
      {err && <p style={{ color: CORAL }}>{err}</p>}
      {analyzing && <p className="muted" style={{ fontSize: 12.5 }}>Reading every post and scoring link opportunities… keep this tab open.</p>}
      {data && !data.configured && <p className="muted">Needs Webflow + <code>WEBFLOW_BLOG_POSTS_ID</code> + <code>ANTHROPIC_API_KEY</code>, plus <code>scripts/content_crosslinks.sql</code>.</p>}
      {!loading && data?.configured && !run && !analyzing && <p className="muted">Run the first analysis to generate opportunities.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 6, border: "1px solid var(--line,#e3ddcf)", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
            <thead>
              <tr>
                {canInsert && <th style={{ ...th, width: 30, textAlign: "center" }}><input type="checkbox" checked={allSelected} onChange={toggleAll} title="Select all shown" style={{ cursor: "pointer" }} /></th>}
                <th style={{ ...th, width: 60 }}>Score</th>
                <th style={th}>In this post</th>
                <th style={th}>Anchor text</th>
                <th style={th}>Link to</th>
                <th style={th}>Why</th>
                {data?.canInsert && <th style={th}>Insert</th>}
                <th style={{ ...th, textAlign: "right" }}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} style={{ background: selected.has(o.id) ? "#eaf4ee" : o.feedback === "up" ? "#f2f8f4" : undefined }}>
                  {canInsert && <td style={{ ...cell, textAlign: "center" }}>{o.status === "inserted" ? null : <input type="checkbox" checked={selected.has(o.id)} onChange={() => toggleOne(o.id)} style={{ cursor: "pointer" }} />}</td>}
                  <td style={{ ...cell, fontWeight: 800, color: scoreColor(Number(o.score) || 0) }}>{Math.round(Number(o.score) || 0)}</td>
                  <td style={cell}><PostLink title={o.source_title} slug={o.source_slug} color="var(--navy,#254254)" /></td>
                  <td style={{ ...cell, maxWidth: 320 }} title={o.kind === "add_sentence" ? (o.new_sentence || "") : (o.context || "")}><AnchorCell o={o} /></td>
                  <td style={cell}><PostLink title={o.target_title} slug={o.target_slug} color="#2f6f7a" prefix="→ " /></td>
                  <td style={{ ...cell, maxWidth: 300, color: "var(--navy-2,#4a5b66)" }}>{o.rationale || "—"}</td>
                  {data?.canInsert && (
                    <td style={{ ...cell, whiteSpace: "nowrap" }}>
                      {o.status === "inserted"
                        ? <span style={{ color: "#1f7a5a", fontWeight: 700, fontSize: 12 }}>✓ Inserted</span>
                        : <span style={{ display: "inline-flex", gap: 4 }}>
                            <button title="Insert as a staged draft in Webflow (review, then publish)" style={{ ...BTN, padding: "3px 8px" }} disabled={busyId === o.id} onClick={() => insert(o, false)}>Insert</button>
                            <button title="Insert and publish live now" style={{ ...BTNP, padding: "3px 8px" }} disabled={busyId === o.id} onClick={() => insert(o, true)}>＋ Live</button>
                          </span>}
                    </td>
                  )}
                  <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                    <button title="Super relevant (boost + learn)" style={{ ...BTN, padding: "3px 8px", borderColor: o.feedback === "up" ? "#1f7a5a" : undefined, color: o.feedback === "up" ? "#1f7a5a" : undefined }} disabled={busyId === o.id} onClick={() => act(o, "up")}>👍</button>{" "}
                    <button title="Not relevant (remove + learn)" style={{ ...BTN, padding: "3px 8px" }} disabled={busyId === o.id} onClick={() => act(o, "down")}>👎</button>{" "}
                    <button title="Dismiss (hide)" style={{ ...BTN, padding: "3px 8px", color: "var(--muted,#889)" }} disabled={busyId === o.id} onClick={() => act(o, "dismiss")}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
