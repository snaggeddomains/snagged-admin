"use client";

import { useCallback, useEffect, useState, type CSSProperties } from "react";

type SnapOpp = { domain: string; quality_score: number | null; category: string | null; enriched: boolean; price: number | null; best_price_source: string | null; num_words: number | null; is_mub: boolean | null; source: string };
type AucOpp = { domain: string; price: number | null; endTimeUtc: string | null; bidCount: number | null; link: string | null; quality_score: number | null; num_words: number | null; is_mub: boolean | null; source: string; altSources?: string[] };
type Report = { snap: SnapOpp[]; auctions: AucOpp[]; snapSources: number; auctionSources: number; generatedAt: string };
type Pick = { domain: string; bucket: "snap" | "auction"; source: string; link: string | null; cost: number | null; quality_score: number | null; is_mub: boolean | null; endTimeUtc?: string | null; appraisalMid: number | null; tldCount: number | null; tldBand: string | null; ratio: number | null };
type PicksReport = { snap: Pick[]; auctions: Pick[]; valued: boolean; generatedAt: string };

const usd = (n: number | null) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);
const tldOf = (domain: string) => { const i = domain.lastIndexOf("."); return i < 0 ? "" : domain.slice(i + 1).toLowerCase(); };

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
  // Atom listing pages live at /name/<Domain> with the SLD's first letter
  // capitalized (e.g. ballroom.ai -> https://www.atom.com/name/Ballroom.ai).
  if (s.includes("atom")) return `https://www.atom.com/name/${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
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
// Pipeline quality_score badge (green ≥4 / amber ≥2 / grey else); "—" when the
// name carries no score (not enriched / not in name_universe).
function QualityCell({ q }: { q: number | null }) {
  if (q == null) return <span className="muted">—</span>;
  const [bg, fg] = q >= 4 ? ["#e3efe6", "#2f7d4f"] : q >= 2 ? ["#fdf0d4", "#946200"] : ["#f0eee8", "#7a7568"];
  return <span style={{ display: "inline-block", minWidth: 34, textAlign: "center", padding: "1px 7px", borderRadius: 6, fontSize: 12.5, fontWeight: 700, background: bg, color: fg }}>{q.toFixed(1)}</span>;
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
const DEFAULT_DIR: Record<string, 1 | -1> = { ends: 1, domain: 1, category: 1, source: 1, tld: 1, price: -1, bids: -1, quality: -1 };
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
      : key === "quality" ? (a.quality_score ?? -1) : key === "tld" ? tldOf(a.domain)
      : key === "source" ? sourceDisplay(a.source).name : (a.endTimeUtc ? new Date(a.endTimeUtc).getTime() : Infinity);
  return [...rows].sort((a, b) => cmp(v(a), v(b), dir));
}
function sortSnap(rows: SnapOpp[], { key, dir }: Sort): SnapOpp[] {
  const v = (d: SnapOpp): number | string =>
    key === "domain" ? d.domain : key === "category" ? (d.category ?? "~") : key === "price" ? (d.price ?? -1)
      : key === "tld" ? tldOf(d.domain)
      : key === "source" ? sourceDisplay(d.source).name : (d.quality_score ?? -1);
  return [...rows].sort((a, b) => cmp(v(a), v(b), dir));
}

// ── Filters (shared across both tables) ───────────────────────────────────────
type Filters = { priceMin: string; priceMax: string; source: string; tld: string; oneWord: "all" | "yes" | "no"; mub: "all" | "yes" | "no" };
const EMPTY_FILTERS: Filters = { priceMin: "", priceMax: "", source: "all", tld: "all", oneWord: "all", mub: "all" };
// A row carries the common fields both tables share for filtering.
function matchesFilters(row: { domain: string; price: number | null; source: string; num_words: number | null; is_mub: boolean | null }, f: Filters): boolean {
  const min = f.priceMin === "" ? null : Number(f.priceMin);
  const max = f.priceMax === "" ? null : Number(f.priceMax);
  if (min != null && !Number.isNaN(min)) { if (row.price == null || row.price < min) return false; }
  if (max != null && !Number.isNaN(max)) { if (row.price == null || row.price > max) return false; }
  if (f.source !== "all" && row.source !== f.source) return false;
  if (f.tld !== "all" && tldOf(row.domain) !== f.tld) return false;
  if (f.oneWord === "yes" && row.num_words !== 1) return false;
  if (f.oneWord === "no" && row.num_words === 1) return false;
  if (f.mub === "yes" && row.is_mub !== true) return false;
  if (f.mub === "no" && row.is_mub === true) return false;
  return true;
}
const filtersActive = (f: Filters) => f.priceMin !== "" || f.priceMax !== "" || f.source !== "all" || f.tld !== "all" || f.oneWord !== "all" || f.mub !== "all";

const fInput: CSSProperties = { width: 78, padding: "5px 8px", borderRadius: 7, border: "1px solid #d9d2c2", background: "#fff", fontSize: 13 };
const fSelect: CSSProperties = { padding: "5px 8px", borderRadius: 7, border: "1px solid #d9d2c2", background: "#fff", fontSize: 13 };
const fLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--navy-3, #6b6450)", textTransform: "uppercase", letterSpacing: ".03em", marginRight: 2 };

function FilterBar({ filters, setFilters, sources, tlds }: { filters: Filters; setFilters: (f: Filters) => void; sources: string[]; tlds: string[] }) {
  const set = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });
  return (
    <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", padding: "12px 14px", border: "1px solid #e3ddcf", borderRadius: 10, background: "var(--cream-2, #fbf7ec)", margin: "10px 0 4px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={fLabel}>Price</span>
        <input style={fInput} type="number" inputMode="numeric" placeholder="min" value={filters.priceMin} onChange={(e) => set({ priceMin: e.target.value })} />
        <span className="muted" style={{ fontSize: 12 }}>–</span>
        <input style={fInput} type="number" inputMode="numeric" placeholder="max" value={filters.priceMax} onChange={(e) => set({ priceMax: e.target.value })} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={fLabel}>Source</span>
        <select style={fSelect} value={filters.source} onChange={(e) => set({ source: e.target.value })}>
          <option value="all">All</option>
          {sources.map((s) => <option key={s} value={s}>{sourceDisplay(s).name}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={fLabel}>TLD</span>
        <select style={fSelect} value={filters.tld} onChange={(e) => set({ tld: e.target.value })}>
          <option value="all">All</option>
          {tlds.map((t) => <option key={t} value={t}>.{t}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={fLabel}>Words</span>
        <select style={fSelect} value={filters.oneWord} onChange={(e) => set({ oneWord: e.target.value as Filters["oneWord"] })}>
          <option value="all">Any</option>
          <option value="yes">One-word</option>
          <option value="no">Multi-word</option>
        </select>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={fLabel}>✨ MUB</span>
        <select style={fSelect} value={filters.mub} onChange={(e) => set({ mub: e.target.value as Filters["mub"] })} title="Made-Up Brandable">
          <option value="all">Any</option>
          <option value="yes">MUB only</option>
          <option value="no">Non-MUB</option>
        </select>
      </div>
      {filtersActive(filters) && (
        <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} style={{ fontSize: 12.5, background: "none", border: "none", color: "var(--coral-deep, #c0492f)", fontWeight: 700, cursor: "pointer", textDecoration: "underline" }}>Clear</button>
      )}
    </div>
  );
}

function ratioText(r: number | null): string {
  if (r == null) return "—";
  return r >= 10 ? `${Math.round(r)}×` : `${r.toFixed(1)}×`;
}
function PickRow({ p }: { p: Pick }) {
  const strong = p.ratio != null && p.ratio >= 3;
  return (
    <tr style={{ borderTop: "1px solid var(--line, #eee)" }}>
      <td style={{ padding: "6px 16px 6px 0", fontWeight: 600 }}>
        <a href={p.link || `http://${p.domain}`} target="_blank" rel="noreferrer" style={{ color: "var(--navy, #254254)", textDecoration: "none" }}>{p.domain}</a>
        {p.is_mub ? <span title="Made-up brandable" style={{ marginLeft: 5 }}>✨</span> : null}
      </td>
      <td style={{ padding: "6px 16px 6px 0" }}><SourcePill source={p.source} /></td>
      <td className="right" style={{ padding: "6px 24px 6px 0", textAlign: "right" }}>{usd(p.cost)}</td>
      <td className="right" style={{ padding: "6px 24px 6px 0", textAlign: "right" }}>
        {p.appraisalMid != null
          ? <a href={`/research/appraisal/${encodeURIComponent(p.domain)}`} target="_blank" rel="noreferrer" title="Open the appraisal run for this name" style={{ color: "var(--navy, #254254)", fontWeight: 600 }}>{usd(p.appraisalMid)}</a>
          : usd(p.appraisalMid)}
      </td>
      <td className="right" style={{ padding: "6px 24px 6px 0", textAlign: "right", fontWeight: strong ? 800 : 600, color: strong ? "var(--green-deep, #2f7d4f)" : "inherit" }}>{ratioText(p.ratio)}</td>
      <td className="right" style={{ padding: "6px 0 6px 0", textAlign: "right", color: "var(--muted, #667)" }}>{p.tldCount != null ? `${p.tldCount}${p.tldBand ? ` · ${p.tldBand}` : ""}` : "—"}</td>
    </tr>
  );
}
function PicksTable({ title, rows }: { title: string; rows: Pick[] }) {
  if (!rows.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 700, margin: "6px 0", color: "var(--navy, #254254)" }}>{title}</div>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
        <thead><tr style={{ textAlign: "left", color: "var(--muted, #667)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".03em" }}>
          <th style={{ padding: "0 16px 4px 0" }}>Domain</th><th style={{ padding: "0 16px 4px 0" }}>Source</th>
          <th className="right" style={{ padding: "0 24px 4px 0", textAlign: "right" }}>Cost</th>
          <th className="right" style={{ padding: "0 24px 4px 0", textAlign: "right" }}>Appraisal</th>
          <th className="right" style={{ padding: "0 24px 4px 0", textAlign: "right" }}>Value/cost</th>
          <th className="right" style={{ padding: "0 0 4px 0", textAlign: "right" }}>TLDs</th>
        </tr></thead>
        <tbody>{rows.map((p) => <PickRow key={p.domain} p={p} />)}</tbody>
      </table>
    </div>
  );
}
function PicksSection({ picks, loading }: { picks: PicksReport | null; loading: boolean }) {
  const has = picks && (picks.snap.length || picks.auctions.length);
  return (
    <div style={{ border: "1px solid var(--line, #e6e6e6)", borderRadius: 10, padding: "12px 16px", margin: "10px 0 18px", background: "var(--paper, #fff)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 15, fontWeight: 800 }}>🔎 Worth a look</span>
        <span className="muted" style={{ fontSize: 12 }}>top 5 new-snap + top 5 auctions expiring today, appraised &amp; ranked by value ÷ cost</span>
      </div>
      {loading && !picks ? <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>Valuing the shortlist…</p> : null}
      {picks && !picks.valued && has ? <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>Appraisals unavailable (research valuation not configured) — showing the quality shortlist.</p> : null}
      {picks && !has && !loading ? <p className="muted" style={{ fontSize: 13, margin: "8px 0 0" }}>Nothing expiring today / no new snap to rank.</p> : null}
      {has ? (
        <div style={{ marginTop: 8 }}>
          <PicksTable title="⏰ Auctions expiring today" rows={picks!.auctions} />
          <PicksTable title="🆕 New SNAP" rows={picks!.snap} />
        </div>
      ) : null}
    </div>
  );
}

export default function OpportunitiesClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [aucSort, setAucSort] = useState<Sort>({ key: "ends", dir: 1 });
  const [snapSort, setSnapSort] = useState<Sort>({ key: "quality", dir: -1 });
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Quality floor is TLD-specific: .xyz is flooded with forgettable keyword combos
  // in the 2.x band, so it needs a higher bar (3.0); every other TLD keeps the 1.0
  // floor that just trims the 0.x drop junk.
  const BASE_FLOOR = 1.0;
  const XYZ_FLOOR = 3.0;
  const floorFor = (domain: string) => (/\.xyz$/i.test(domain) ? XYZ_FLOOR : BASE_FLOOR);

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

  // "Worth a look" valued picks — lazy-loaded so the main list renders instantly
  // while the ~10 appraisals run in the research app.
  const [picks, setPicks] = useState<PicksReport | null>(null);
  const [picksLoading, setPicksLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setPicksLoading(true);
    fetch("/api/admin/opportunities/picks", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d && d.picks) setPicks(d.picks as PicksReport); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setPicksLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const endingSoon = report ? report.auctions.filter((a) => { const c = countdown(a.endTimeUtc, now); return c.soon && !c.ended; }).length : 0;
  // Option lists for the filter dropdowns — union across both tables, sorted.
  const sourceOpts = report ? [...new Set([...report.auctions, ...report.snap].map((r) => r.source))].sort((a, b) => sourceDisplay(a).name.localeCompare(sourceDisplay(b).name)) : [];
  const tldOpts = report ? [...new Set([...report.auctions, ...report.snap].map((r) => tldOf(r.domain)).filter(Boolean))].sort() : [];
  const auctions = report ? sortAuctions(report.auctions.filter((a) => matchesFilters(a, filters)), aucSort) : [];
  const snap = report ? sortSnap(report.snap.filter((d) => matchesFilters(d, filters)), snapSort) : [];
  const snapShown = snap.filter((d) => (d.quality_score ?? 0) >= floorFor(d.domain));

  return (
    <main>
      <style>{`.opp-table th, .opp-table td { padding-right: 24px; } .opp-table th.right, .opp-table td.right { padding-right: 52px; } .opp-table th:last-child, .opp-table td:last-child { padding-right: 0; }`}</style>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>SNAP opportunities</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Everything the pipeline surfaced as new today — live auctions and SNAP candidates — in one place. Filter by price, source,
        TLD, one-word, or <strong>✨ MUB</strong>; click any column to sort (e.g. <strong>Ends in</strong> for time-sensitive names).
      </p>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "14px 0", flexWrap: "wrap" }}>
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        {report && <span className="muted" style={{ fontSize: 12 }}>updated {new Date(report.generatedAt).toLocaleTimeString()}</span>}
      </div>
      {msg && <p style={{ fontSize: 13, color: "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      <PicksSection picks={picks} loading={picksLoading} />

      {!report && loading ? <p className="muted">Loading…</p> : report ? (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
            <Stat label="Live auctions" value={report.auctions.length} />
            <Stat label="Ending within 1h" value={endingSoon} accent />
            <Stat label="New SNAP today" value={snapShown.length} />
            <Stat label="Sources" value={report.auctionSources + report.snapSources} />
          </div>

          <FilterBar filters={filters} setFilters={setFilters} sources={sourceOpts} tlds={tldOpts} />

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 17 }}>Auctions <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {filtersActive(filters) ? `${auctions.length.toLocaleString()} of ${report.auctions.length}` : `${report.auctions.length} live`} · {report.auctionSources} sources</span></h2>
            {report.auctions.length === 0 ? <p className="muted">No live auctions right now.</p> : auctions.length === 0 ? (
              <p className="muted">No live auctions match these filters.</p>
            ) : (
              <div className="table-scroll"><table className="dash opp-table" style={{ width: "100%" }}>
                <thead><tr>
                  <SortHeader label="Domain" k="domain" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="TLD" k="tld" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="Price" k="price" sort={aucSort} setSort={setAucSort} align="right" />
                  <SortHeader label="Quality" k="quality" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="Ends in" k="ends" sort={aucSort} setSort={setAucSort} />
                  <SortHeader label="Source" k="source" sort={aucSort} setSort={setAucSort} />
                  <th></th>
                </tr></thead>
                <tbody>
                  {auctions.map((a, i) => (
                    <tr key={a.domain + a.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{a.is_mub ? <span title="Made-Up Brandable">✨ </span> : null}{a.domain}</td>
                      <td className="muted" style={{ fontSize: 12.5 }}>.{tldOf(a.domain)}</td>
                      <td className="right" style={{ fontWeight: 600 }}>{usd(a.price)}</td>
                      <td><QualityCell q={a.quality_score} /></td>
                      <td><CountdownBadge end={a.endTimeUtc} now={now} />{a.bidCount != null ? <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{a.bidCount} bid{a.bidCount === 1 ? "" : "s"}</span> : null}</td>
                      <td><SourcePill source={a.source} />{a.altSources && a.altSources.length > 0 ? <span className="muted" style={{ fontSize: 11, marginLeft: 6, whiteSpace: "nowrap" }} title={`Also on ${a.altSources.map((s) => sourceDisplay(s).name).join(", ")}`}>+{a.altSources.length}</span> : null}</td>
                      <td className="right">{a.link ? <a href={a.link} target="_blank" rel="noreferrer" style={linkBtn}>Bid →</a> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </section>

          <section style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 17 }}>Snap <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>· {snapShown.length.toLocaleString()} {filtersActive(filters) ? "match" : "new today"} (quality ≥ {BASE_FLOOR.toFixed(1)}, ≥ {XYZ_FLOOR.toFixed(1)} for .xyz) · {report.snapSources} sources</span></h2>
            {report.snap.length === 0 ? <p className="muted">No new SNAP candidates today.</p> : snapShown.length === 0 ? (
              <p className="muted">{filtersActive(filters) ? "No names match these filters." : "No names clear today’s quality floor."}</p>
            ) : (
              <div className="table-scroll"><table className="dash opp-table" style={{ width: "100%" }}>
                <thead><tr>
                  <SortHeader label="Domain" k="domain" sort={snapSort} setSort={setSnapSort} />
                  <SortHeader label="TLD" k="tld" sort={snapSort} setSort={setSnapSort} />
                  <SortHeader label="Price" k="price" sort={snapSort} setSort={setSnapSort} align="right" />
                  <SortHeader label="Quality" k="quality" sort={snapSort} setSort={setSnapSort} />
                  <SortHeader label="Source" k="source" sort={snapSort} setSort={setSnapSort} />
                  <th></th>
                </tr></thead>
                <tbody>
                  {snapShown.map((d, i) => (
                    <tr key={d.domain + d.source + i}>
                      <td className="mono" style={{ fontWeight: 600 }}>{d.is_mub ? <span title="Made-Up Brandable">✨ </span> : null}{d.domain}</td>
                      <td className="muted" style={{ fontSize: 12.5 }}>.{tldOf(d.domain)}</td>
                      <td className="right">{usd(d.price)}</td>
                      <td><QualityCell q={d.quality_score} /></td>
                      <td><SourcePill source={d.source} /></td>
                      <td className="right"><a href={snapLink(d.domain, d.source)} target="_blank" rel="noreferrer" style={linkBtn}>View →</a></td>
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
