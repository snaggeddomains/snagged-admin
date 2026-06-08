"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type SnapOpp = { domain: string; quality_score: number | null; category: string | null; enriched: boolean; price: number | null; best_price_source: string | null; source: string };
type AucOpp = { domain: string; price: number | null; endTimeUtc: string | null; bidCount: number | null; link: string | null; source: string };
type Report = { snap: SnapOpp[]; auctions: AucOpp[]; snapSources: number; auctionSources: number; generatedAt: string };

const usd = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

// Known sources → a deliberate, distinct color + clean root name (no "Auctions").
const SOURCE_STYLE: Record<string, { name: string; bg: string; fg: string }> = {
  namecheap: { name: "Namecheap", bg: "#fdeadf", fg: "#c0492f" },
  dropcatch: { name: "Dropcatch", bg: "#dcedf0", fg: "#1f6f7a" },
  godaddy: { name: "GoDaddy", bg: "#e2efe5", fg: "#2f7d4f" },
  dynadot: { name: "Dynadot", bg: "#efe7f5", fg: "#6b4a8a" },
  parkio: { name: "Park.io", bg: "#e6e8f5", fg: "#3f4a8f" },
  sav: { name: "Sav", bg: "#fdf0d2", fg: "#946200" },
  namejet: { name: "NameJet", bg: "#fbe0ea", fg: "#a83265" },
  oxley: { name: "Oxley", bg: "#e6edf2", fg: "#254254" },
  efty: { name: "Efty", bg: "#def0e9", fg: "#1f7a5a" },
  atom: { name: "Atom", bg: "#e9ecf4", fg: "#44486a" },
  afternic: { name: "Afternic", bg: "#f1e7dc", fg: "#875428" },
  sedo: { name: "Sedo", bg: "#ede6f6", fg: "#5b3b8c" },
};
const FALLBACK: [string, string][] = [
  ["#efe8f5", "#6b4a8a"], ["#fdeadf", "#c0492f"], ["#dcedf0", "#1f6f7a"], ["#e2efe5", "#2f7d4f"],
  ["#fdf0d2", "#946200"], ["#e6e8f5", "#3f4a8f"], ["#fbe0ea", "#a83265"], ["#def0e9", "#1f7a5a"],
];
function sourceDisplay(s: string): { name: string; bg: string; fg: string } {
  const base = s.toLowerCase().replace(/[_-]?auctions?$/, "");
  const key = base.replace(/[_-]/g, "");
  if (SOURCE_STYLE[key]) return SOURCE_STYLE[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const [bg, fg] = FALLBACK[h % FALLBACK.length];
  return { name: base.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), bg, fg };
}
function SourcePill({ source }: { source: string }) {
  const { name, bg, fg } = sourceDisplay(source);
  return <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: bg, color: fg, whiteSpace: "nowrap" }}>{name}</span>;
}

function snapLink(domain: string, source: string | null): string {
  const s = (source || "").toLowerCase();
  if (s.includes("afternic")) return `https://www.afternic.com/domain/${domain}`;
  if (s.includes("sedo")) return `https://sedo.com/search/?keyword=${encodeURIComponent(domain)}`;
  if (s.includes("atom")) return `https://www.atom.com/search?q=${encodeURIComponent(domain)}`;
  if (s.includes("dan")) return `https://dan.com/buy-domain/${domain}`;
  return `http://${domain}`;
}
const linkBtn: CSSProperties = { display: "inline-block", padding: "3px 11px", borderRadius: 7, background: "var(--navy, #254254)", color: "#fff", fontSize: 12, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" };

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
  return { text: d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`, soon, ended: false };
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

// ── Sorting ──────────────────────────────────────────────────────────────────
type Sort = { key: string; dir: 1 | -1 };
const DEFAULT_DIR: Record<string, 1 | -1> = { ends: 1, domain: 1, category: 1, source: 1, price: -1, bids: -1, quality: -1 };
function SortHeader({ label, k, sort, setSort, align }: { label: string; k: string; sort: Sort; setSort: (s: Sort) => void; align?: "right" }) {
  const active = sort.key === k;
  return (
    <th
      className={align === "right" ? "right" : undefined}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      onClick={() => setSort(active ? { key: k, dir: (sort.dir * -1) as 1 | -1 } : { key: k, dir: DEFAULT_DIR[k] ?? 1 })}
    >
      {label}<span style={{ fontSize: 9, marginLeft: 4, opacity: active ? 1 : 0.25 }}>{active ? (sort.dir === 1 ? "▲" : "▼") : "▾"}</span>
    </th>
  );
}
function cmp(a: number | string, b: number | string, dir: 1 | -1): number {
  if (a < b) return -dir;
  if (a > b) return dir;
  return 0;
}
function sortAuctions(rows: AucOpp[], { key, dir }: Sort): AucOpp[] {
  const v = (a: AucOpp): number | string =>
    key === "domain" ? a.domain : key === "price" ? (a.price ?? -1) : key === "bids" ? (a.bidCount ?? -1)
      : key === "source" ? sourceDisplay(a.source).name : (a.endTimeUtc ? new Date(a.endTimeUtc).getTime() : Infinity);
  return [...rows].sort((a, b) => cmp(v(a), v(b), dir));
}
function sortSnap(rows: SnapOpp[], { key, dir }: Sort): SnapOpp[] {
  const v = (d: SnapOpp): number | string =>
    key === "domain" ? d.domain : key === "category" ? (d.category ?? "~") : key === "price" ? (d.price ?? -1)
      : key === "source" ? sourceDisplay(d.source).name : (d.quality_score ?? -1);
  return [...rows].sort((a, b) => cmp(v(a), v(b), dir));
}

export default function OpportunitiesClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [aucSort, setAucSort] = useState<Sort>({ key: "ends", dir: 1 });
  const [snapSort, setSnapSort] = useState<Sort>({ key: "quality", dir: -1 });

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
  const auctions = report ? sortAuctions(report.auctions, aucSort) : [];
  const snap = report ? sortSnap(report.snap, snapSort) : [];

  return (
    <main>
      <style>{`.opp-table th, .opp-table td { padding-right: 24px; } .opp-table th:last-child, .opp-table td:last-child { padding-right: 0; }`}</style>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>SNAP opportunities</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Everything the pipeline surfaced as new today — live auctions and SNAP candidates — in one place. Click any column to
        sort (e.g. <strong>Ends in</strong> for time-sensitive names).
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
            {report.auctions.length === 0 ? <p className="muted">No live auctions right now.</p> : (
              <div className="table-scroll"><table className="dash opp-table" style={{ width: "100%" }}>
                <thead><tr>
                  <SortHeader label="Domain" k="domain" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="Price" k="price" sort={aucSort} setSort={setAucSort} align="right" />
                  <SortHeader label="Bids" k="bids" sort={aucSort} setSort={setAucSort} align="right" />
                  <SortHeader label="Ends in" k="ends" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="Source" k="source" sort={aucSort} setSort={setAucSort} />
                  <th></th>
                </tr></thead>
                <tbody>
                  {auctions.map((a, i) => (
                    <tr key={a.domain + a.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{a.domain}</td>
                      <td className="right" style={{ fontWeight: 600 }}>{usd(a.price)}</td>
                      <td className="right muted">{a.bidCount ?? "—"}</td>
                      <td><CountdownBadge end={a.endTimeUtc} now={now} /></td>
                      <td><SourcePill source={a.source} /></td>
                      <td className="right">{a.link ? <a href={a.link} target="_blank" rel="noreferrer" style={linkBtn}>Bid →</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          <section style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 17 }}>Snap <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {report.snap.length} new today · {report.snapSources} sources</span></h2>
            {report.snap.length === 0 ? <p className="muted">No new SNAP candidates today.</p> : (
              <div className="table-scroll"><table className="dash opp-table" style={{ width: "100%" }}>
                <thead><tr>
                  <SortHeader label="Domain" k="domain" sort={snapSort} setSort={setSnapSort} />
                  <SortHeader label="Quality" k="quality" sort={snapSort} setSort={setSnapSort} align="right" />
                  <SortHeader label="Category" k="category" sort={snapSort} setSort={setSnapSort} />
                  <SortHeader label="Price" k="price" sort={snapSort} setSort={setSnapSort} align="right" />
                  <SortHeader label="Source" k="source" sort={snapSort} setSort={setSnapSort} />
                  <th></th>
                </tr></thead>
                <tbody>
                  {snap.map((d, i) => (
                    <tr key={d.domain + d.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{d.domain}</td>
                      <td className="right">{d.quality_score == null ? <span className="muted">—</span> : (
                        <span style={{ display: "inline-block", minWidth: 34, textAlign: "center", padding: "1px 7px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: d.quality_score >= 4 ? "#e3efe6" : d.quality_score >= 2 ? "#fdf0d4" : "#f0eee8", color: d.quality_score >= 4 ? "#2f7d4f" : d.quality_score >= 2 ? "#946200" : "#7a7568" }}>{d.quality_score.toFixed(1)}</span>
                      )}</td>
                      <td className="muted">{d.category ?? (d.enriched ? "—" : "unenriched")}</td>
                      <td className="right">{usd(d.price)}{d.best_price_source ? <span className="muted" style={{ fontSize: 11 }}> · {d.best_price_source}</span> : null}</td>
                      <td><SourcePill source={d.source} /></td>
                      <td className="right"><a href={snapLink(d.domain, d.best_price_source || d.source)} target="_blank" rel="noreferrer" style={linkBtn}>View →</a></td>
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
