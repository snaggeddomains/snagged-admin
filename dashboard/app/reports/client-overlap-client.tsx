"use client";

import { useEffect, useState, useCallback } from "react";

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
const UNKNOWN = "Unknown client — attribute after review";

function fmtDate(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  return new Date(y, (m || 1) - 1, day || 1).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function tierLabel(t: "exact_tld" | "affix"): string {
  return t === "exact_tld" ? "same word · new TLD" : ".com variation";
}

export default function ClientOverlapClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exactOnly, setExactOnly] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [openDay, setOpenDay] = useState<string | null>(null);
  const [dayDomains, setDayDomains] = useState<{ domain: string; clients: string[]; sources: string[] }[] | null>(null);
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

  const flags = (data?.flags || []).filter((f) => (exactOnly ? f.best_tier === "exact_tld" : true));

  // Group by client (a multi-client flag appears under each label).
  const groups = new Map<string, Flag[]>();
  for (const f of flags) {
    for (const c of f.clients.length ? f.clients : [UNKNOWN]) {
      const arr = groups.get(c); if (arr) arr.push(f); else groups.set(c, [f]);
    }
  }
  const clientNames = [...groups.keys()].sort((a, b) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : a.localeCompare(b)));

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

      {/* Controls */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", margin: "10px 0 14px", fontSize: 13 }}>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={exactOnly} onChange={(e) => setExactOnly(e.target.checked)} /> Exact-word matches only</label>
        <label style={{ cursor: "pointer" }}><input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} /> Show dismissed</label>
        <button onClick={() => void load()} style={{ marginLeft: "auto", cursor: "pointer" }}>↻ Refresh</button>
      </div>

      {err && <p style={{ color: "#cf3b3b" }}>Couldn’t load: {err}</p>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && !flags.length && !loading && <p className="muted">No open matches right now. New feed names are checked against the client list every day.</p>}

      {clientNames.map((client) => (
        <section key={client} style={{ marginBottom: 18 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: "1rem" }}>{client === UNKNOWN ? "🕵 Unknown client — attribute after review" : client}</h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {(groups.get(client) || []).sort((a, b) => (a.best_tier !== b.best_tier ? (a.best_tier === "exact_tld" ? -1 : 1) : a.candidate_domain.localeCompare(b.candidate_domain))).map((f) => {
              const anchors = [...new Set(f.matches.map((m) => m.anchor))];
              const draft = `mailto:?subject=${encodeURIComponent(`${f.candidate_domain} just came up`)}&body=${encodeURIComponent(`Saw ${f.candidate_domain} come available — it's a close match to ${anchors.join(", ")}. Want me to look into acquiring it?`)}`;
              return (
                <div key={f.candidate_domain} style={{ border: "1px solid #eee", borderRadius: 8, padding: "8px 10px", background: f.dismissed ? "#f6f6f6" : "#fff", opacity: f.dismissed ? 0.6 : 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <a href={f.link || `https://${f.candidate_domain}`} target="_blank" rel="noreferrer" style={{ fontWeight: 700, fontSize: 15 }}>{f.candidate_domain}</a>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", padding: "1px 7px", borderRadius: 4, background: f.best_tier === "exact_tld" ? "#d1f0d6" : "#fdf0c8", color: f.best_tier === "exact_tld" ? "#176a2b" : "#8a6300" }}>{tierLabel(f.best_tier)}</span>
                    {f.price != null && <span style={{ fontSize: 13, color: "#333" }}>${Math.round(f.price).toLocaleString()}</span>}
                    {f.source_feed && <span style={{ fontSize: 12, color: "#999" }}>{f.source_feed.split(",")[0]}</span>}
                    <span style={{ fontSize: 12, color: "#bbb", marginLeft: "auto" }}>{fmtDate(f.run_date)}</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#555", marginTop: 3 }}>matches <em>{anchors.join(", ")}</em></div>
                  <div style={{ display: "flex", gap: 10, marginTop: 6, fontSize: 12 }}>
                    <a href={draft}>✉ Draft to client</a>
                    <button onClick={() => void navigator.clipboard?.writeText(f.candidate_domain)} style={{ cursor: "pointer", border: "none", background: "none", color: "#357", padding: 0 }}>Copy</button>
                    <button onClick={() => dismiss(f.candidate_domain, !f.dismissed)} style={{ cursor: "pointer", border: "none", background: "none", color: "#999", padding: 0, marginLeft: "auto" }}>{f.dismissed ? "Restore" : "Dismiss"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
