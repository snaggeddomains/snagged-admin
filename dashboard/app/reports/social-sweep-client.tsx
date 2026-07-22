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
  followers: number | null;
  verified: boolean;
  suggested_reply: string;
  dismissed: boolean;
  first_seen_at: string;
};
type Vip = "vip" | "high" | "notable" | null;
function vipBand(followers: number | null, verified: boolean): Vip {
  const f = followers || 0;
  if (f >= 100_000) return "vip";
  if (f >= 25_000) return "high";
  if (f >= 5_000 || (verified && f >= 2_000)) return "notable";
  return null;
}
function fmtFollowers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}
const VIP_STYLE: Record<string, { label: string; bg: string; fg: string }> = {
  vip: { label: "🌟 VIP", bg: "#ffe9b0", fg: "#8a5a00" },
  high: { label: "⭐ high-profile", bg: "#fff2cc", fg: "#8a6300" },
  notable: { label: "notable", bg: "#eef2f7", fg: "#556" },
};
type Health = { lastRunAt: string | null; lastOk: boolean | null; feedErrors: string[]; status: "green" | "yellow" | "red"; error: string | null };
type MutedAuthor = { author: string; platform: string | null; muted_by: string | null; created_at: string };
type Payload = { posts: Post[]; health: Health; muted?: MutedAuthor[] };

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

  const mute = useCallback(async (author: string | null, platform: string | null) => {
    if (!author) return;
    const handle = author.replace(/^@+/, "");
    if (!window.confirm(`Mute @${handle}? None of their posts will show in the sweep again.`)) return;
    const res = await fetch(`/api/admin/social-sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "mute", author, platform }) });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
    if (!res.ok || j.ok === false) {
      window.alert("Couldn't save the mute — the mute list isn't set up on the server yet. Run scripts/social_sweep.sql (the social_sweep_muted table) on the main project.");
      return;
    }
    void load();
  }, [load]);

  const unmute = useCallback(async (author: string) => {
    await fetch(`/api/admin/social-sweep`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unmute", author }) });
    void load();
  }, [load]);

  const raw = data?.posts || [];
  const vipRank: Record<string, number> = { vip: 0, high: 1, notable: 2 };
  // VIPs float to the top (respond fast), then the server order (recency / score).
  const posts = [...raw].sort((a, b) => {
    const va = vipRank[vipBand(a.followers, a.verified) || ""] ?? 3;
    const vb = vipRank[vipBand(b.followers, b.verified) || ""] ?? 3;
    if (va !== vb) return va - vb;
    return (b.followers || 0) - (a.followers || 0);
  });
  const high = posts.filter((p) => p.bucket === "high-signal").length;
  const vipCount = posts.filter((p) => vipBand(p.followers, p.verified)).length;
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
        Domain posts skimmed from Reddit (and X) from OUTSIDE the domainer echo chamber. Two kinds: <strong style={{ color: "#b23000" }}>🎯 High intent</strong> (actively looking for a broker / to buy — a lead) and <strong>💬 Worth engaging</strong> (founders/VCs discussing domains where we can add expert authority). Each row shows why it fired + a suggested angle.
      </p>

      {h && h.feedErrors.length > 0 && (
        <p style={{ fontSize: 13, color: "#8a6300", background: "#fdf6e3", border: "1px solid #f0e2b8", borderRadius: 6, padding: "6px 10px" }}>
          ⚠ {h.feedErrors.length} subreddit feed{h.feedErrors.length === 1 ? "" : "s"} failed to fetch this run ({h.feedErrors.slice(0, 6).join(", ")}{h.feedErrors.length > 6 ? "…" : ""}). If it&apos;s all of them, set <code>SCRAPE_DO_API_KEY</code> in the Vercel project (Reddit blocks cloud egress).
        </p>
      )}

      <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "12px 0", fontSize: 13 }}>
        <strong style={{ fontSize: 14 }}>🎯 {high.toLocaleString()} high-intent{showMaybe ? ` · 💬 ${(posts.length - high).toLocaleString()} worth engaging` : ""}{vipCount ? ` · 🌟 ${vipCount} VIP` : ""}</strong>
        <span style={{ display: "inline-flex", gap: 6 }}>
          {([["", "All"], ["reddit", "Reddit"], ["x", "X"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setPlatform(v)}
              style={{ cursor: "pointer", fontSize: 12, padding: "3px 10px", borderRadius: 999, border: `1px solid ${platform === v ? "#357" : "#ddd"}`, background: platform === v ? "#eef4ff" : "#fff" }}>{label}</button>
          ))}
        </span>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showMaybe} onChange={(e) => setShowMaybe(e.target.checked)} /> Include &ldquo;worth engaging&rdquo;</label>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed</label>
        <button onClick={() => void load()} style={{ marginLeft: "auto", cursor: "pointer" }}>↻ Refresh</button>
      </div>

      {data?.muted && data.muted.length > 0 && (
        <details style={{ margin: "0 0 12px", fontSize: 13 }}>
          <summary style={{ cursor: "pointer", color: "#667" }}>🔇 Muted authors ({data.muted.length})</summary>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {data.muted.map((m) => (
              <span key={m.author} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, background: "#f2f2f2", color: "#555" }}>
                @{m.author}{m.platform ? ` · ${m.platform}` : ""}
                <button onClick={() => unmute(m.author)} title="Unmute" style={{ cursor: "pointer", border: "none", background: "none", color: "#b23000", fontWeight: 700 }}>✕</button>
              </span>
            ))}
          </div>
        </details>
      )}

      {err && <p style={{ color: "#cf3b3b" }}>Couldn&apos;t load: {err}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && !posts.length && !loading && <p className="muted">No open leads. New posts are scored on each sweep.</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {posts.map((p) => {
          const vb = vipBand(p.followers, p.verified);
          const vip = vb ? VIP_STYLE[vb] : null;
          return (
          <div key={p.id} style={{ border: vb === "vip" || vb === "high" ? "1.5px solid #f0c95a" : "1px solid #eee", borderRadius: 8, padding: "10px 12px", background: p.dismissed ? "#f7f7f7" : vb === "vip" || vb === "high" ? "#fffdf5" : p.bucket === "high-signal" ? "#fbfdff" : "#fff", opacity: p.dismissed ? 0.55 : 1 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              {p.bucket === "high-signal"
                ? <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 3, background: "#ffe0d1", color: "#b23000" }}>🎯 high intent</span>
                : <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 3, background: "#e8eef5", color: "#456" }}>💬 engage</span>}
              {vip && <span title={p.followers != null ? `${p.followers.toLocaleString()} followers` : "high-profile"} style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 3, background: vip.bg, color: vip.fg }}>{vip.label}{p.followers != null ? ` · ${fmtFollowers(p.followers)}` : ""}</span>}
              <span style={{ fontSize: 12, color: "#888" }}>{sourceLabel(p)}{p.verified ? " ✔︎" : ""} · score {p.score}{p.buy_side ? " · buy-side" : ""}{p.published ? ` · ${ago(p.published)}` : ""}</span>
              <span style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
                <a href={p.link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>open ↗</a>
                <button onClick={() => dismiss(p.id, !p.dismissed)} style={{ ...linkBtn, color: "#999", marginLeft: 10 }}>{p.dismissed ? "restore" : "dismiss"}</button>
                {p.author && <button onClick={() => mute(p.author, p.platform)} title={`Mute @${p.author.replace(/^@+/, "")} — hide all their posts`} style={{ ...linkBtn, color: "#b23000", marginLeft: 10 }}>mute @{p.author.replace(/^@+/, "")}</button>}
              </span>
            </div>
            <a href={p.link} target="_blank" rel="noreferrer" style={{ display: "block", fontWeight: 600, color: "#1b2a3a", textDecoration: "none", margin: "4px 0 2px" }}>{p.title || "(untitled)"}</a>
            {p.matched.length > 0 && <div style={{ fontSize: 12, color: "#777" }}>matched: {p.matched.slice(0, 8).join(", ")}</div>}
            {p.suggested_reply ? (
              <div style={{ marginTop: 6, background: "#f4f8f4", border: "1px solid #dcebdc", borderRadius: 6, padding: "7px 9px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".03em", color: "#2c6e3f" }}>✍️ Suggested reply · @snagged</span>
                  <button onClick={() => void navigator.clipboard?.writeText(p.suggested_reply)} style={{ ...linkBtn, color: "#2c6e3f" }}>copy</button>
                </div>
                <div style={{ fontSize: 13, color: "#233", whiteSpace: "pre-wrap" }}>{p.suggested_reply}</div>
              </div>
            ) : p.sample ? <div style={{ fontSize: 12.5, color: "#2c5", marginTop: 4 }}>↳ {p.sample}</div> : null}
          </div>
          );
        })}
      </div>
      <p className="muted" style={{ fontSize: 11, marginTop: 16 }}>
        <span style={th as never} /> Suggested angles are advisory — nothing is auto-posted. Reply from the actual account.
      </p>
    </main>
  );
}
