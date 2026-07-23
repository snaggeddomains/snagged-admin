"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Opp = {
  id: string; source_id: string; source_title: string | null; source_slug: string | null;
  target_id: string; target_title: string | null; target_slug: string | null;
  anchor: string | null; context: string | null; rationale: string | null; score: number | null;
  status: string; feedback: "up" | "down" | null;
};
type Run = { id: string; status: string; started_at: string; finished_at: string | null; posts: number | null; opportunities: number | null; error: string | null };
type Resp = { ok: boolean; configured: boolean; run: Run | null; opportunities: Opp[]; error?: string };

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

export default function CrosslinksView() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

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
      (Number(o.score) || 0) >= minScore &&
      (!t || `${o.source_title} ${o.target_title} ${o.anchor} ${o.rationale}`.toLowerCase().includes(t)));
  }, [data, q, minScore]);

  const run = data?.run;
  const scoreColor = (s: number) => s >= 75 ? "#1f7a5a" : s >= 55 ? "#946200" : "#7a6f63";

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", margin: "6px 0 10px" }}>
        <button style={BTNP} onClick={analyze} disabled={analyzing}>{analyzing ? "Analyzing… (a few min)" : (run ? "↻ Re-analyze" : "Analyze the blog")}</button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {run ? <>Last analyzed {when(run.finished_at || run.started_at)} · {run.opportunities ?? 0} opportunities across {run.posts ?? 0} posts{run.status !== "done" ? ` · ${run.status}` : ""}</> : "Not analyzed yet."}
        </span>
      </div>
      <p className="section-blurb" style={{ marginTop: 0 }}>
        Stack-ranked internal-link opportunities — where one post should link to another, for SEO. 👍 super-relevant / 👎 not relevant trains future runs; 👎 removes it. Highly-relevant only.
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

      {err && <p style={{ color: CORAL }}>{err}</p>}
      {analyzing && <p className="muted" style={{ fontSize: 12.5 }}>Reading every post and scoring link opportunities… keep this tab open.</p>}
      {data && !data.configured && <p className="muted">Needs Webflow + <code>WEBFLOW_BLOG_POSTS_ID</code> + <code>ANTHROPIC_API_KEY</code>, plus <code>scripts/content_crosslinks.sql</code>.</p>}
      {!loading && data?.configured && !run && !analyzing && <p className="muted">Run the first analysis to generate opportunities.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 6, border: "1px solid var(--line,#e3ddcf)", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: 60 }}>Score</th>
                <th style={th}>In this post</th>
                <th style={th}>Anchor text</th>
                <th style={th}>Link to</th>
                <th style={th}>Why</th>
                <th style={{ ...th, textAlign: "right" }}>Rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} style={{ background: o.feedback === "up" ? "#f2f8f4" : undefined }}>
                  <td style={{ ...cell, fontWeight: 800, color: scoreColor(Number(o.score) || 0) }}>{Math.round(Number(o.score) || 0)}</td>
                  <td style={cell}><PostLink title={o.source_title} slug={o.source_slug} color="var(--navy,#254254)" /></td>
                  <td style={{ ...cell, maxWidth: 260 }} title={o.context || ""}><span style={{ background: "#fdf3d8", borderRadius: 4, padding: "1px 5px", fontWeight: 600 }}>{o.anchor || "—"}</span></td>
                  <td style={cell}><PostLink title={o.target_title} slug={o.target_slug} color="#2f6f7a" prefix="→ " /></td>
                  <td style={{ ...cell, maxWidth: 300, color: "var(--navy-2,#4a5b66)" }}>{o.rationale || "—"}</td>
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
