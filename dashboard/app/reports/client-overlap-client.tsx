"use client";

import { useEffect, useState, useCallback, type CSSProperties } from "react";

type MatchEntry = { anchor: string; clients: string[]; tier: "exact_tld" | "affix"; affix: string | null };
type Flag = {
  run_date: string;
  candidate_domain: string;
  candidate_sld: string;
  candidate_tld: string;
  best_tier: "exact_tld" | "affix";
  clients: string[];
  matches: MatchEntry[];
  source_feed: string | null;
  price: number | null;
  price_source: string | null;
  link: string | null;
  dismissed: boolean;
};
type Health = { total: number; lastRunAt: string | null; lastOk: boolean | null; status: "green" | "yellow" | "red"; lastError: string | null };
type AddedDay = { date: string; count: number };
type Payload = { flags: Flag[]; added: AddedDay[]; health: Health };

const DOT: Record<string, string> = { green: "#1f9d55", yellow: "#c98a00", red: "#cf3b3b" };
const th: CSSProperties = { padding: "4px 8px", fontWeight: 600 };
const td: CSSProperties = { padding: "5px 8px", verticalAlign: "top" };
const linkBtn: CSSProperties = { cursor: "pointer", border: "none", background: "none", color: "#357", padding: 0, fontSize: 12 };

function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function tierLabel(t: "exact_tld" | "affix"): string {
  return t === "exact_tld" ? "same word · new TLD" : ".com variation";
}
const SOURCE_LABELS: [string, string][] = [
  ["afternic", "Afternic"], ["sedo", "Sedo"], ["atom", "Atom"], ["namecheap", "Namecheap"],
  ["efty", "Efty"], ["oxley", "Oxley"], ["brandbucket", "BrandBucket"], ["dan", "Dan"],
  ["namepros", "NamePros"], ["spaceship", "Spaceship"], ["dynadot", "Dynadot"], ["godaddy", "GoDaddy"],
];
function cleanSource(feed: string | null): string {
  if (!feed) return "";
  const s = feed.split(",")[0].toLowerCase().replace(/[[\]]/g, "");
  for (const [k, label] of SOURCE_LABELS) if (s.includes(k)) return label;
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function affixOf(f: Flag): string | null {
  return f.matches.find((x) => x.tier === "affix" && x.affix)?.affix || null;
}
function rootOf(f: Flag): string {
  const anchors = [...new Set(f.matches.map((m) => m.anchor))];
  if (!anchors.length) return `${f.candidate_sld}.com`;
  return anchors.find((a) => a.endsWith(".com")) || anchors.slice().sort((a, b) => a.length - b.length)[0];
}
function clientName(f: Flag): string {
  return f.clients.filter((c) => c && !/^snagged master txns$/i.test(c)).join(", ");
}

export default function ClientOverlapClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exactOnly, setExactOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [dayDomains, setDayDomains] = useState<{ domain: string; clients: string[]; sources: string[] }[] | null>(null);
  const [selTlds, setSelTlds] = useState<Set<string>>(new Set());
  const [selAffixes, setSelAffixes] = useState<Set<string>>(new Set());
  // "View all tracked names" corpus browser.
  const [showCorpus, setShowCorpus] = useState(false);
  const [corpus, setCorpus] = useState<{ rows: { domain: string; clients: string[]; sources: string[] }[]; total: number } | null>(null);
  const [corpusQ, setCorpusQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/client-overlap?dismissed=${showDismissed ? "1" : "0"}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
      setErr(null);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, [showDismissed]);

  useEffect(() => { void load(); }, [load]);

  const openDrill = useCallback(async (date: string) => {
    if (openDay === date) { setOpenDay(null); setDayDomains(null); return; }
    setOpenDay(date);
    setDayDomains(null);
    try {
      const res = await fetch(`/api/admin/client-overlap?addedOn=${date}`, { cache: "no-store" });
      const j = await res.json();
      setDayDomains(j.domains || []);
    } catch {
      setDayDomains([]);
    }
  }, [openDay]);

  const loadCorpus = useCallback(async (q: string) => {
    setCorpus(null);
    try {
      const res = await fetch(`/api/admin/client-overlap?corpus=1&q=${encodeURIComponent(q)}`, { cache: "no-store" });
      const j = await res.json();
      setCorpus({ rows: j.rows || [], total: j.total || 0 });
    } catch {
      setCorpus({ rows: [], total: 0 });
    }
  }, []);

  const toggleCorpus = useCallback(() => {
    const next = !showCorpus;
    setShowCorpus(next);
    if (next && !corpus) void loadCorpus("");
  }, [showCorpus, corpus, loadCorpus]);

  const dismiss = useCallback(async (domain: string, dismissed: boolean) => {
    await fetch(`/api/admin/client-overlap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss", domain, dismissed }) });
    void load();
  }, [load]);

  const allFlags = data?.flags || [];
  // Filter facets (built from the full set, before filtering).
  const tldFacets = [...new Set(allFlags.map((f) => f.candidate_tld))].sort();
  const affixFacets = [...new Set(allFlags.map(affixOf).filter(Boolean) as string[])].sort();

  const flags = allFlags.filter((f) =>
    (exactOnly ? f.best_tier === "exact_tld" : true) &&
    (selTlds.size ? selTlds.has(f.candidate_tld) : true) &&
    (selAffixes.size ? (affixOf(f) ? selAffixes.has(affixOf(f)!) : false) : true),
  );
  // One flat grid, sorted so matches under the same root domain bundle together.
  const rows = [...flags].sort((a, b) => {
    const ra = rootOf(a), rb = rootOf(b);
    if (ra !== rb) return ra.localeCompare(rb);
    if (a.best_tier !== b.best_tier) return a.best_tier === "exact_tld" ? -1 : 1;
    return a.candidate_domain.localeCompare(b.candidate_domain);
  });
  const toggle = (set: Set<string>, v: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set); if (n.has(v)) n.delete(v); else n.add(v); setter(n);
  };

  const h = data?.health;
  return (
    <main style={{ maxWidth: 920 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ fontSize: "1.25rem", margin: 0 }}>Client Domain Overlap</h1>
        {h && (
          <span title={`Corpus: ${h.total.toLocaleString()} domains · last build ${h.lastRunAt ? new Date(h.lastRunAt).toLocaleString() : "never"}${h.lastError ? ` · error: ${h.lastError}` : ""}`}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "#666" }}>
            <span style={{ width: 10, height: 10, borderRadius: "50%", background: DOT[h.status] }} />
            {h.total.toLocaleString()} tracked
          </span>
        )}
        <button onClick={toggleCorpus} style={{ marginLeft: "auto", cursor: "pointer", fontSize: 13 }}>
          {showCorpus ? "✕ Hide tracked names" : "📇 View all tracked names"}
        </button>
      </div>

      {/* Corpus browser — confirm exactly what we're matching against. */}
      {showCorpus && (
        <div style={{ margin: "12px 0", border: "1px solid #e2e2e2", borderRadius: 8, padding: 12, background: "#fbfbfb" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            <input value={corpusQ} onChange={(e) => setCorpusQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void loadCorpus(corpusQ); }}
              placeholder="search domain or client…" style={{ flex: 1, padding: "5px 8px", fontSize: 13 }} />
            <button onClick={() => void loadCorpus(corpusQ)} style={{ cursor: "pointer" }}>Search</button>
            {corpus && <span style={{ fontSize: 12, color: "#888" }}>{corpus.total.toLocaleString()} tracked{corpus.total > corpus.rows.length ? ` · showing ${corpus.rows.length}` : ""}</span>}
          </div>
          {!corpus ? <div className="muted">Loading…</div> : corpus.rows.length === 0 ? <div className="muted">No matches.</div> : (
            <div style={{ maxHeight: 320, overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <tbody>
                  {corpus.rows.map((r) => (
                    <tr key={r.domain} style={{ borderBottom: "1px solid #f0f0f0" }}>
                      <td style={{ padding: "3px 6px", fontWeight: 600 }}>{r.domain}</td>
                      <td style={{ padding: "3px 6px", color: "#555" }}>{r.clients.filter((c) => c && !/^snagged master txns$/i.test(c)).join(", ")}</td>
                      <td style={{ padding: "3px 6px", color: "#aaa", fontSize: 11, whiteSpace: "nowrap" }}>{r.sources.map((s) => s.replace(/^\[|\]$/g, "").replace(/^Gmail:.*/, "Gmail")).join(" ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <p className="muted" style={{ marginTop: 4 }}>
        New names from the marketplace/auction feeds that match a domain a client owns or was hunting — exact word on a new TLD, or a <code>.com</code> prefix/suffix variation.
      </p>

      {/* Names-added history — the confidence strip. */}
      {data?.added?.length ? (
        <div style={{ margin: "14px 0" }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em", color: "#888", marginBottom: 6 }}>Names added to the corpus</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {data.added.slice(0, 14).map((d) => (
              <button key={d.date} onClick={() => openDrill(d.date)}
                style={{ cursor: "pointer", border: "1px solid #ddd", borderRadius: 6, padding: "4px 9px", background: openDay === d.date ? "#eef4ff" : "#fafafa", fontSize: 13 }}>
                {fmtDate(d.date)} <strong>{d.count}</strong>
              </button>
            ))}
          </div>
          {openDay && (
            <div style={{ marginTop: 8, border: "1px solid #eee", borderRadius: 6, padding: 10, background: "#fcfcfc" }}>
              <div style={{ fontSize: 13, color: "#555", marginBottom: 6 }}>Added {fmtDate(openDay)} — {dayDomains ? dayDomains.length : "…"} name{dayDomains && dayDomains.length === 1 ? "" : "s"}</div>
              {dayDomains == null ? <div className="muted">Loading…</div> : dayDomains.length === 0 ? <div className="muted">None.</div> : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 220, overflow: "auto" }}>
                  {dayDomains.map((x) => (
                    <span key={x.domain} title={[...x.clients, ...x.sources].join(" · ")} style={{ fontSize: 12, background: "#fff", border: "1px solid #eee", borderRadius: 4, padding: "2px 7px" }}>{x.domain}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* Controls + filters */}
      <div style={{ margin: "10px 0 10px", fontSize: 13 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <strong style={{ fontSize: 14 }}>{flags.length.toLocaleString()} match{flags.length === 1 ? "" : "es"}{flags.length !== allFlags.length ? ` · of ${allFlags.length.toLocaleString()}` : ""}</strong>
          <label style={{ cursor: "pointer" }}><input type="checkbox" checked={exactOnly} onChange={(e) => setExactOnly(e.target.checked)} /> Exact-word only</label>
          <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed</label>
          <button onClick={() => void load()} style={{ marginLeft: "auto", cursor: "pointer" }}>↻ Refresh</button>
        </div>
        {tldFacets.length > 1 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
            <span style={{ color: "#888", fontSize: 12 }}>TLD:</span>
            {tldFacets.map((t) => (
              <button key={t} onClick={() => toggle(selTlds, t, setSelTlds)}
                style={{ cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 999, border: `1px solid ${selTlds.has(t) ? "#357" : "#ddd"}`, background: selTlds.has(t) ? "#eef4ff" : "#fff" }}>.{t}</button>
            ))}
            {selTlds.size > 0 && <button onClick={() => setSelTlds(new Set())} style={{ cursor: "pointer", fontSize: 12, border: "none", background: "none", color: "#999" }}>clear</button>}
          </div>
        )}
        {affixFacets.length > 0 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
            <span style={{ color: "#888", fontSize: 12 }}>Prefix/suffix:</span>
            {affixFacets.map((a) => (
              <button key={a} onClick={() => toggle(selAffixes, a, setSelAffixes)}
                style={{ cursor: "pointer", fontSize: 12, padding: "2px 8px", borderRadius: 999, border: `1px solid ${selAffixes.has(a) ? "#357" : "#ddd"}`, background: selAffixes.has(a) ? "#eef4ff" : "#fff" }}>{a.startsWith("-") ? `…${a.slice(1)}` : `${a.replace(/-$/, "")}…`}</button>
            ))}
            {selAffixes.size > 0 && <button onClick={() => setSelAffixes(new Set())} style={{ cursor: "pointer", fontSize: 12, border: "none", background: "none", color: "#999" }}>clear</button>}
          </div>
        )}
      </div>

      {err && <p style={{ color: "#cf3b3b" }}>Couldn’t load: {err}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && !rows.length && !loading && <p className="muted">No open matches. New feed names are checked against the client list every day.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888", fontSize: 11, textTransform: "uppercase", letterSpacing: ".03em", borderBottom: "1.5px solid #e8e8e8" }}>
                <th style={th}>Prospective domain</th><th style={th}>Price</th><th style={th}>Root domain</th><th style={th}>Source</th><th style={th}>Link</th><th style={th}>Client</th><th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.candidate_domain} style={{ borderTop: "1px solid #f0f0f0", background: f.dismissed ? "#f7f7f7" : "#fff", opacity: f.dismissed ? 0.55 : 1 }}>
                  <td style={td}>
                    <span style={{ fontWeight: 600 }}>{f.candidate_domain}</span>
                    <span title={tierLabel(f.best_tier)} style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 5px", borderRadius: 3, background: f.best_tier === "exact_tld" ? "#d1f0d6" : "#fdf0c8", color: f.best_tier === "exact_tld" ? "#176a2b" : "#8a6300" }}>{f.best_tier === "exact_tld" ? "new TLD" : ".com var"}</span>
                  </td>
                  <td style={td}>{f.price != null ? `$${Math.round(f.price).toLocaleString()}` : <span style={{ color: "#bbb" }}>—</span>}</td>
                  <td style={{ ...td, color: "#555" }}>{rootOf(f)}</td>
                  <td style={td}>{cleanSource(f.source_feed) || <span style={{ color: "#bbb" }}>—</span>}</td>
                  <td style={td}>{f.link ? <a href={f.link} target="_blank" rel="noreferrer">view ↗</a> : <span style={{ color: "#bbb" }}>—</span>}</td>
                  <td style={td}>{clientName(f) || <span style={{ color: "#bbb" }}>—</span>}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    <button onClick={() => void navigator.clipboard?.writeText(f.candidate_domain)} style={linkBtn}>copy</button>
                    <button onClick={() => dismiss(f.candidate_domain, !f.dismissed)} style={{ ...linkBtn, color: "#999", marginLeft: 8 }}>{f.dismissed ? "restore" : "dismiss"}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
