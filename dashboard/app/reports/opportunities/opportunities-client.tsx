"use client";

import { useCallback, useEffect, useState } from "react";

type SnapOpp = { domain: string; quality_score: number | null; category: string | null; enriched: boolean; price: number | null; best_price_source: string | null; source: string };
type AucOpp = { domain: string; price: number | null; endTimeUtc: string | null; bidCount: number | null; link: string | null; source: string };
type Report = { snap: SnapOpp[]; auctions: AucOpp[]; snapSources: number; auctionSources: number; generatedAt: string };

const prettySource = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const usd = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

// Deterministic pill color per source so each source reads the same day to day.
const PILL_COLORS: [string, string][] = [
  ["#e8eef2", "#254254"], ["#fbe7e0", "#c0492f"], ["#e3efe6", "#2f7d4f"], ["#efe8f5", "#6b4a8a"],
  ["#fdf0d4", "#946200"], ["#dfeef0", "#1f6f7a"], ["#f1e7dc", "#875428"], ["#e7e8f4", "#3f4a8f"],
];
function pillColor(s: string): [string, string] {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PILL_COLORS[h % PILL_COLORS.length];
}
function SourcePill({ source }: { source: string }) {
  const [bg, fg] = pillColor(source);
  return <span style={{ display: "inline-block", padding: "2px 9px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" }}>{prettySource(source)}</span>;
}

function countdown(end: string | null, now: number): { text: string; soon: boolean; ended: boolean } {
  if (!end) return { text: "—", soon: false, ended: false };
  const t = new Date(end).getTime();
  if (Number.isNaN(t)) return { text: "—", soon: false, ended: false };
  let ms = t - now;
  if (ms <= 0) return { text: "ended", soon: false, ended: true };
  const soon = ms < 60 * 60 * 1000;
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  return { text, soon, ended: false };
}
function CountdownBadge({ end, now }: { end: string | null; now: number }) {
  const c = countdown(end, now);
  const [bg, fg] = c.ended ? ["#ececec", "#8a8a8a"] : c.soon ? ["#fbe7e0", "#c0492f"] : ["#e8eef2", "#254254"];
  return <span style={{ display: "inline-block", minWidth: 92, textAlign: "center", padding: "3px 8px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", background: bg, color: fg }}>{c.text}</span>;
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ border: "1px solid #e3ddcf", borderRadius: 10, padding: "10px 16px", minWidth: 120, flex: "1 1 120px" }}>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent ? "var(--coral-deep, #c0492f)" : "var(--navy, #254254)" }}>{value.toLocaleString()}</div>
      <div className="muted" style={{ fontSize: 12, marginTop: 1 }}>{label}</div>
    </div>
  );
}

export default function OpportunitiesClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true); setMsg("");
    try {
      const res = await fetch("/api/admin/opportunities", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setReport(data.report as Report);
    } catch (e) { setMsg(String((e as Error).message || e)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const endingSoon = report ? report.auctions.filter((a) => { const c = countdown(a.endTimeUtc, now); return c.soon && !c.ended; }).length : 0;

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>SNAP opportunities</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Everything the pipeline surfaced as new today — live auctions and SNAP candidates — in one place. Same per-source
        &ldquo;new today&rdquo; data as the Admin dashboard, aggregated.
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "14px 0", flexWrap: "wrap" }}>
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        {report && <span className="muted" style={{ fontSize: 12 }}>updated {new Date(report.generatedAt).toLocaleTimeString()}</span>}
      </div>
      {msg && <p style={{ fontSize: 13, color: "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      {!report && loading ? <p className="muted">Loading…</p> : report ? (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
            <Stat label="Live auctions" value={report.auctions.length} />
            <Stat label="Ending within 1h" value={endingSoon} accent />
            <Stat label="New SNAP today" value={report.snap.length} />
            <Stat label="Sources" value={report.auctionSources + report.snapSources} />
          </div>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 17 }}>Auctions <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {report.auctions.length} live · {report.auctionSources} sources</span></h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>Soonest-ending first — the clock is live.</p>
            {report.auctions.length === 0 ? <p className="muted">No live auctions right now.</p> : (
              <div className="table-scroll"><table className="dash" style={{ width: "100%" }}>
                <thead><tr><th>Domain</th><th className="right">Price</th><th className="right">Bids</th><th>Ends in</th><th>Source</th><th></th></tr></thead>
                <tbody>
                  {report.auctions.map((a, i) => (
                    <tr key={a.domain + a.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{a.domain}</td>
                      <td className="right" style={{ fontWeight: 600 }}>{usd(a.price)}</td>
                      <td className="right muted">{a.bidCount ?? "—"}</td>
                      <td><CountdownBadge end={a.endTimeUtc} now={now} /></td>
                      <td><SourcePill source={a.source} /></td>
                      <td className="right">{a.link ? <a href={a.link} target="_blank" rel="noreferrer" style={{ display: "inline-block", padding: "3px 11px", borderRadius: 7, background: "var(--navy, #254254)", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>Bid →</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          <section style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 17 }}>Snap <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {report.snap.length} new today · {report.snapSources} sources</span></h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>New SNAP candidates today, best quality first.</p>
            {report.snap.length === 0 ? <p className="muted">No new SNAP candidates today.</p> : (
              <div className="table-scroll"><table className="dash" style={{ width: "100%" }}>
                <thead><tr><th>Domain</th><th className="right">Quality</th><th>Category</th><th className="right">Price</th><th>Source</th></tr></thead>
                <tbody>
                  {report.snap.map((d, i) => (
                    <tr key={d.domain + d.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{d.domain}</td>
                      <td className="right">{d.quality_score == null ? <span className="muted">—</span> : (
                        <span style={{ display: "inline-block", minWidth: 34, textAlign: "center", padding: "1px 7px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: d.quality_score >= 4 ? "#e3efe6" : d.quality_score >= 2 ? "#fdf0d4" : "#f0eee8", color: d.quality_score >= 4 ? "#2f7d4f" : d.quality_score >= 2 ? "#946200" : "#7a7568" }}>{d.quality_score.toFixed(1)}</span>
                      )}</td>
                      <td className="muted">{d.category ?? (d.enriched ? "—" : "unenriched")}</td>
                      <td className="right">{usd(d.price)}{d.best_price_source ? <span className="muted" style={{ fontSize: 11 }}> · {d.best_price_source}</span> : null}</td>
                      <td><SourcePill source={d.source} /></td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>
        </>
      ) : <p className="muted">No data.</p>}
    </main>
  );
}
