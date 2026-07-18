"use client";

import { useEffect, useState, useCallback, type CSSProperties } from "react";

type Post = {
  id: string;
  platform: "reddit" | "x";
  source: string;
  title: string;
  link: string;
  author: string | null;
  published: string | null;
  score: number;
  bucket: "high-signal" | "maybe";
  buy_side: boolean;
  sell_side: boolean;
  matched: string[];
  sample: string;
  snippet: string;
  dismissed: boolean;
  first_seen_at: string;
};
type Health = { lastRunAt: string | null; lastOk: boolean | null; feedErrors: string[]; status: "green" | "yellow" | "red"; error: string | null };
type Payload = { posts: Post[]; health: Health };

const DOT: Record<string, string> = { green: "#1f9d55", yellow: "#c98a00", red: "#cf3b3b" };
const sourceLabel = (p: Post) => (p.platform === "x" ? p.source : `r/${p.source}`);

function ago(iso: string | null): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const h = (Date.now() - t) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 24) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function SocialSweepClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState<"" | "reddit" | "x">("");
  const [showMaybe, setShowMaybe] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (platform) qs.set("platform", platform);
      if (showMaybe) qs.set("maybe", "1");
      if (showDismissed) qs.set("dismissed", "1");
      const res = await fetch(`/api/admin/social-sweep?${qs}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [platform, showMaybe, showDismissed]);

  useEffect(() => { void load(); }, [load]);

  const dismiss = useCallback(async (id: string, dismissed: boolean) => {
    await fetch(`/api/admin/social-sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss", id, dismissed }) });
    void load();
  }, [load]);

  const posts = data?.posts || [];
  const high = posts.filter((p) => p.bucket === "high-signal").length;
  const h = data?.health;

  const th: CSSProperties = { padding: "4px 8px", fontWeight: 600 };
  const td: CSSProperties = { padding: "8px", verticalAlign: "top" };
  const linkBtn: CSSProperties = { cursor: "pointer", border: "none", background: "none", color: "#357", padding: 0, fontSize: 12 };

  return (
    <main style={{ maxWidth: 960 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Social Sweep</h1>
        {h && (
          <span title={`last run ${h.lastRunAt ? new Date(h.lastRunAt).toLocaleString() : "never"}${h.feedErrors.length ? ` · feed errors: ${h.feedErrors.join(", ")}` : ""}${h.error ? ` · ${h.error}` : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#666" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: DOT[h.status] }} />
            {h.lastRunAt ? `updated ${ago(h.lastRunAt)}` : "never run"}
          </span>
        )}
      </div>
      <p className="muted" style={{ marginTop: 4 }}>
        Domain-opportunity posts skimmed from Reddit (and X) — buy-side acquisition intent scored highest. Each row shows why it fired and a suggested angle.
      </p>

      {h && h.feedErrors.length > 0 && (
        <p style={{ fontSize: 13, color: "#8a6300", background: "#fdf6e3", border: "1px solid #f0e2b8", borderRadius: 6, padding: "6px 10px" }}>
          ⚠ {h.feedErrors.length} subreddit feed{h.feedErrors.length === 1 ? "" : "s"} failed to fetch this run ({h.feedErrors.slice(0, 6).join(", ")}{h.feedErrors.length > 6 ? "…" : ""}). If it&apos;s all of them, set <code>SCRAPE_DO_API_KEY</code> in the Vercel project (Reddit blocks cloud egress).
        </p>
      )}

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "12px 0", fontSize: 13 }}>
        <strong style={{ fontSize: 14 }}>{high.toLocaleString()} high-signal{showMaybe ? ` · ${(posts.length - high).toLocaleString()} maybe` : ""}</strong>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {([["", "All"], ["reddit", "Reddit"], ["x", "X"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setPlatform(v)}
              style={{ cursor: "pointer", fontSize: 12, padding: "3px 10px", borderRadius: 999, border: `1px solid ${platform === v ? "#357" : "#ddd"}`, background: platform === v ? "#eef4ff" : "#fff" }}>{label}</button>
          ))}
        </span>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showMaybe} onChange={(e) => setShowMaybe(e.target.checked)} /> Include &ldquo;maybe&rdquo;</label>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed</label>
        <button onClick={() => void load()} style={{ marginLeft: "auto", cursor: "pointer" }}>↻ Refresh</button>
      </div>

      {err && <p style={{ color: "#cf3b3b" }}>Couldn&apos;t load: {err}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && !posts.length && !loading && <p className="muted">No open leads. New posts are scored on each sweep.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {posts.map((p) => (
          <div key={p.id} style={{ border: "1px solid #eee", borderRadius: 8, padding: "10px 12px", background: p.dismissed ? "#f7f7f7" : p.bucket === "high-signal" ? "#fbfdff" : "#fff", opacity: p.dismissed ? 0.55 : 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              {p.bucket === "high-signal"
                ? <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 3, background: "#ffe0d1", color: "#b23000" }}>🔥 high-signal</span>
                : <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 3, background: "#e8eef5", color: "#456" }}>maybe</span>}
              <span style={{ fontSize: 12, color: "#888" }}>{sourceLabel(p)} · score {p.score}{p.buy_side ? " · buy-side" : ""}{p.published ? ` · ${ago(p.published)}` : ""}</span>
              <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                <a href={p.link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open ↗</a>
                <button onClick={() => dismiss(p.id, !p.dismissed)} style={{ ...linkBtn, color: "#999", marginLeft: 10 }}>{p.dismissed ? "restore" : "dismiss"}</button>
              </span>
            </div>
            <a href={p.link} target="_blank" rel="noreferrer" style={{ display: "block", fontWeight: 600, color: "#1b2a3a", textDecoration: "none", margin: "4px 0 2px" }}>{p.title || "(untitled)"}</a>
            {p.matched.length > 0 && <div style={{ fontSize: 12, color: "#777" }}>matched: {p.matched.slice(0, 8).join(", ")}</div>}
            {p.sample && <div style={{ fontSize: 12.5, color: "#2c5", marginTop: 4 }}>↳ {p.sample}</div>}
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 16 }}>
        <span style={th as never} /> Suggested angles are advisory — nothing is auto-posted. Reply from the actual account.
      </p>
    </main>
  );
}
