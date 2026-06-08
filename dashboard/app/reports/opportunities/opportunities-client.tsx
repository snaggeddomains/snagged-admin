"use client";

import { useCallback, useEffect, useState } from "react";

type SnapOpp = { domain: string; quality_score: number | null; category: string | null; enriched: boolean; price: number | null; best_price_source: string | null; source: string };
type AucOpp = { domain: string; price: number | null; endTimeUtc: string | null; bidCount: number | null; link: string | null; source: string };
type Report = { snap: SnapOpp[]; auctions: AucOpp[]; snapSources: number; auctionSources: number; generatedAt: string };

const prettySource = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const usd = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

function countdown(end: string | null, now: number): { text: string; soon: boolean; ended: boolean } {
  if (!end) return { text: "—", soon: false, ended: false };
  const t = new Date(end).getTime();
  if (Number.isNaN(t)) return { text: "—", soon: false, ended: false };
  let ms = t - now;
  if (ms <= 0) return { text: "ended", soon: false, ended: true };
  const soon = ms < 60 * 60 * 1000; // < 1h
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000); ms -= m * 60000;
  const s = Math.floor(ms / 1000);
  const text = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
  return { text, soon, ended: false };
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

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>New opportunities</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Everything the pipeline surfaced as new today — SNAP candidates and live auctions — in one place. Same per-source
        &ldquo;new today&rdquo; data as the Admin dashboard, aggregated.
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "14px 0" }}>
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        {report && <span className="muted" style={{ fontSize: 13 }}>{report.snap.length} snap · {report.auctions.length} auctions · updated {new Date(report.generatedAt).toLocaleTimeString()}</span>}
      </div>
      {msg && <p style={{ fontSize: 13, color: "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      {!report && loading ? <p className="muted">Loading…</p> : report ? (
        <>
          <section style={{ marginTop: 18 }}>
            <h2 style={{ fontSize: 17 }}>Auctions <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {report.auctions.length} live · {report.auctionSources} sources</span></h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>Live auctions, soonest-ending first — the clock is live.</p>
            {report.auctions.length === 0 ? <p className="muted">No live auctions right now.</p> : (
              <div className="table-scroll"><table className="dash">
                <thead><tr><th>domain</th><th className="right">price</th><th className="right">bids</th><th className="right">ends in</th><th>source</th><th></th></tr></thead>
                <tbody>
                  {report.auctions.map((a, i) => {
                    const c = countdown(a.endTimeUtc, now);
                    return (
                      <tr key={a.domain + a.source + i}>
                        <td className="mono">{a.domain}</td>
                        <td className="right">{usd(a.price)}</td>
                        <td className="right muted">{a.bidCount ?? "—"}</td>
                        <td className="right" style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700, color: c.ended ? "var(--navy-3, #999)" : c.soon ? "var(--coral-deep, #c0492f)" : "var(--navy, #254254)" }}>{c.text}</td>
                        <td className="muted">{prettySource(a.source)}</td>
                        <td className="right">{a.link ? <a href={a.link} target="_blank" rel="noreferrer">Bid →</a> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </section>

          <section style={{ marginTop: 26 }}>
            <h2 style={{ fontSize: 17 }}>Snap <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {report.snap.length} new today · {report.snapSources} sources</span></h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>New SNAP candidates today, best quality first.</p>
            {report.snap.length === 0 ? <p className="muted">No new SNAP candidates today.</p> : (
              <div className="table-scroll"><table className="dash">
                <thead><tr><th>domain</th><th className="right">quality</th><th>category</th><th className="right">price</th><th>source</th></tr></thead>
                <tbody>
                  {report.snap.map((d, i) => (
                    <tr key={d.domain + d.source + i}>
                      <td className="mono">{d.domain}</td>
                      <td className="right">{d.quality_score == null ? "—" : d.quality_score.toFixed(1)}</td>
                      <td className="muted">{d.category ?? (d.enriched ? "—" : "unenriched")}</td>
                      <td className="right">{usd(d.price)}{d.best_price_source ? <span className="muted" style={{ fontSize: 11 }}> · {d.best_price_source}</span> : null}</td>
                      <td className="muted">{prettySource(d.source)}</td>
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
