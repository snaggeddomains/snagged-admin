"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

type SnapSource = "Berserk" | "SNAP" | "Rob";
type SnapName = {
  domain: string;
  source: SnapSource;
  tld: string;
  date_purchased: string | null;
  purchase_price: number | null;
  internal_price: number | null;
  spaceship_price: number | null;
  atom_price: string | null;
  on_marketplace: boolean | null;
  platform: string | null;
  still_owned: string | null;
  sold: boolean;
  sold_for: number | null;
  sale_date: string | null;
  fees: number | null;
  net_sale_price: number | null;
  list_for_sale: string | null;
  snagged_rep: string | null;
  premium: string | null;
  active: string | null;
  notes: string | null;
  also_in: SnapSource[];
};
type Summary = {
  total: number;
  owned: number;
  sold: number;
  on_marketplace: number;
  total_internal_value: number;
  total_sold_for: number;
  bySource: Record<string, number>;
  generatedAt: string;
};
type Report = { rows: SnapName[]; summary: Summary };
type Live = { registrar: string | null; nameservers: string[]; ns_provider: string | null; checked_at: string };

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

const SOURCE_STYLE: Record<string, { name: string; bg: string; fg: string }> = {
  Berserk: { name: "Berserk", bg: "#f1e7dc", fg: "#875428" },
  SNAP: { name: "SNAP", bg: "#e2efe5", fg: "#2f7d4f" },
  Rob: { name: "Rob", bg: "#e6e8f5", fg: "#3f4a8f" },
};
function SourcePill({ source, also }: { source: string; also?: SnapSource[] }) {
  const s = SOURCE_STYLE[source] || { name: source, bg: "#eee", fg: "#333" };
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg }}>{s.name}</span>
      {also && also.length > 0 && <span title={`Also on: ${also.join(", ")}`} style={{ marginLeft: 5, fontSize: 11, color: "#9a9aac", cursor: "help" }}>+{also.length}</span>}
    </span>
  );
}

const card: CSSProperties = { border: "1px solid #e6e6ef", borderRadius: 12, padding: "14px 16px", background: "#fff" };
const th: CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 12, color: "#6b6b7b", fontWeight: 600, borderBottom: "1px solid #e6e6ef", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" };
const td: CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid #f0f0f5", verticalAlign: "top" };

type SortKey = "domain" | "source" | "tld" | "date" | "purchase" | "internal" | "spaceship" | "registrar" | "status";

// localStorage cache for live lookups so repeat views don't re-resolve.
const LIVE_TTL = 24 * 3600 * 1000;
const liveKey = (d: string) => `snapLive:${d}`;
function readLive(d: string): Live | null {
  try {
    const raw = localStorage.getItem(liveKey(d));
    if (!raw) return null;
    const v = JSON.parse(raw) as Live;
    if (!v.checked_at || Date.now() - Date.parse(v.checked_at) > LIVE_TTL) return null;
    return v;
  } catch {
    return null;
  }
}
function writeLive(d: string, v: Live) {
  try {
    localStorage.setItem(liveKey(d), JSON.stringify(v));
  } catch {
    /* ignore quota */
  }
}

export default function SnapNamesClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [resolving, setResolving] = useState(0); // # domains still pending live lookup
  const liveRef = useRef<Record<string, Live>>({});

  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"all" | SnapSource>("all");
  const [status, setStatus] = useState<"all" | "owned" | "sold" | "marketplace">("all");
  const [tldFilter, setTldFilter] = useState<string>("all");
  const [sortKey, setSortKey] = useState<SortKey>("domain");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/snap-names", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setReport(j.report as Report);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Progressive live registrar/NS resolution: seed from localStorage, then batch
  // the still-unknown domains through /resolve. Fail-open per batch.
  const resolveLive = useCallback(
    async (rows: SnapName[], force = false) => {
      const domains = rows.map((r) => r.domain);
      const seeded: Record<string, Live> = {};
      const todo: string[] = [];
      for (const d of domains) {
        const cached = force ? null : readLive(d);
        if (cached) seeded[d] = cached;
        else todo.push(d);
      }
      if (Object.keys(seeded).length) {
        liveRef.current = { ...liveRef.current, ...seeded };
        setLive({ ...liveRef.current });
      }
      if (!todo.length) return;
      setResolving(todo.length);
      const BATCH = 25;
      for (let i = 0; i < todo.length; i += BATCH) {
        const chunk = todo.slice(i, i + BATCH);
        try {
          const res = await fetch("/api/admin/snap-names/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: chunk }),
          });
          const j = await res.json();
          const results = (j?.results || {}) as Record<string, Live>;
          for (const [d, v] of Object.entries(results)) {
            liveRef.current[d] = v;
            writeLive(d, v);
          }
          setLive({ ...liveRef.current });
        } catch {
          /* leave this chunk unresolved */
        }
        setResolving((n) => Math.max(0, n - chunk.length));
      }
      setResolving(0);
    },
    []
  );

  useEffect(() => {
    if (report?.rows?.length) resolveLive(report.rows);
  }, [report, resolveLive]);

  const tlds = useMemo(() => {
    if (!report) return [];
    const counts = new Map<string, number>();
    for (const r of report.rows) counts.set(r.tld, (counts.get(r.tld) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [report]);

  const filtered = useMemo(() => {
    if (!report) return [];
    const needle = q.trim().toLowerCase();
    let rows = report.rows.filter((r) => {
      if (src !== "all" && r.source !== src) return false;
      if (status === "owned" && r.sold) return false;
      if (status === "sold" && !r.sold) return false;
      if (status === "marketplace" && !r.on_marketplace) return false;
      if (tldFilter !== "all" && r.tld !== tldFilter) return false;
      if (needle) {
        const reg = live[r.domain]?.registrar || "";
        const ns = (live[r.domain]?.nameservers || []).join(" ");
        const hay = `${r.domain} ${r.platform || ""} ${reg} ${ns}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const val = (r: SnapName): string | number => {
      switch (sortKey) {
        case "domain": return r.domain;
        case "source": return r.source;
        case "tld": return r.tld;
        case "date": return r.date_purchased ? Date.parse(r.date_purchased) || 0 : 0;
        case "purchase": return r.purchase_price ?? -1;
        case "internal": return r.internal_price ?? -1;
        case "spaceship": return r.spaceship_price ?? -1;
        case "registrar": return (live[r.domain]?.registrar || "￿").toLowerCase();
        case "status": return r.sold ? 2 : r.on_marketplace ? 1 : 0;
        default: return 0;
      }
    };
    rows = [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return a.domain < b.domain ? -1 : 1;
    });
    return rows;
  }, [report, q, src, status, tldFilter, sortKey, sortDir, live]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "domain" || k === "source" || k === "tld" || k === "registrar" ? 1 : -1);
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === 1 ? " ▲" : " ▼") : "");

  const downloadCsv = () => {
    const cols = ["domain", "source", "also_in", "tld", "date_purchased", "purchase_price", "internal_price", "spaceship_price", "atom_price", "on_marketplace", "platform", "registrar", "nameservers", "ns_provider", "still_owned", "sold_for", "sale_date", "net_sale_price", "fees", "list_for_sale", "snagged_rep", "premium", "active", "notes"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : Array.isArray(v) ? v.join(" | ") : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of filtered) {
      const l = live[r.domain];
      const rowObj: Record<string, unknown> = { ...r, registrar: l?.registrar ?? "", nameservers: l?.nameservers ?? [], ns_provider: l?.ns_provider ?? "" };
      lines.push(cols.map((c) => esc(rowObj[c])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snap-names.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const s = report?.summary;

  return (
    <main style={{ maxWidth: "var(--maxw, 1280px)", margin: "0 auto", padding: "0 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>SNAP Names</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every domain we&apos;ve purchased / hold for sale, de-duped to one row each (Berserk wins), with live registrar + nameserver lookups.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={downloadCsv} disabled={!filtered.length} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            ⬇ CSV
          </button>
          <button onClick={() => report && resolveLive(report.rows, true)} disabled={!report || resolving > 0} title="Re-resolve registrar + nameservers live" style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            {resolving > 0 ? `Resolving ${resolving}…` : "⟳ Re-resolve live"}
          </button>
          <button onClick={load} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {err && <div style={{ ...card, marginTop: 16, borderColor: "#f0c0c0", background: "#fdf3f3", color: "#a33" }}>{err}</div>}

      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 16 }}>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Unique names</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.total}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Still owned</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.owned}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Sold</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.sold}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>On marketplace</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.on_marketplace}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Internal value (owned)</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_internal_value)}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Total sold for</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_sold_for)}</div></div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 18 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domain / registrar / NS…" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13, minWidth: 220 }} />
        <Segmented value={src} onChange={(v) => setSrc(v as typeof src)} options={[["all", "All sources"], ["SNAP", "SNAP"], ["Rob", "Rob"], ["Berserk", "Berserk"]]} />
        <Segmented value={status} onChange={(v) => setStatus(v as typeof status)} options={[["all", "All"], ["owned", "Owned"], ["sold", "Sold"], ["marketplace", "On marketplace"]]} />
        <select value={tldFilter} onChange={(e) => setTldFilter(e.target.value)} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }}>
          <option value="all">All TLDs</option>
          {tlds.map((t) => <option key={t} value={t}>.{t}</option>)}
        </select>
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {filtered.length} shown{resolving > 0 ? ` · resolving ${resolving} live…` : ""}
        </span>
      </div>

      <div style={{ ...card, marginTop: 12, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={th} onClick={() => setSort("domain")}>Domain{arrow("domain")}</th>
              <th style={th} onClick={() => setSort("source")}>Source{arrow("source")}</th>
              <th style={th} onClick={() => setSort("tld")}>TLD{arrow("tld")}</th>
              <th style={th} onClick={() => setSort("date")}>Purchased{arrow("date")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("purchase")}>Cost{arrow("purchase")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("internal")}>Internal{arrow("internal")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("spaceship")}>Spaceship{arrow("spaceship")}</th>
              <th style={th}>Platform</th>
              <th style={th} onClick={() => setSort("registrar")}>Registrar{arrow("registrar")}</th>
              <th style={th}>Nameservers → points to</th>
              <th style={th} onClick={() => setSort("status")}>Status{arrow("status")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const l = live[r.domain];
              return (
                <tr key={`${r.domain}-${i}`}>
                  <td style={{ ...td, fontWeight: 600 }}>
                    {r.domain}
                    {r.notes && <span title={r.notes} style={{ marginLeft: 6, cursor: "help", opacity: 0.6 }}>📝</span>}
                  </td>
                  <td style={td}><SourcePill source={r.source} also={r.also_in} /></td>
                  <td style={{ ...td, color: "#6b6b7b" }}>.{r.tld}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: "#6b6b7b" }}>{r.date_purchased || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{usd(r.purchase_price)}</td>
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{usd(r.internal_price)}</td>
                  <td style={{ ...td, textAlign: "right", color: "#6b6b7b" }}>{usd(r.spaceship_price)}</td>
                  <td style={{ ...td, color: "#6b6b7b", whiteSpace: "nowrap" }}>{r.platform || "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{l ? l.registrar || <span style={{ color: "#b8b8c4" }}>—</span> : <span style={{ color: "#c8c8d2" }}>…</span>}</td>
                  <td style={td}>
                    {l ? (
                      l.nameservers.length ? (
                        <span>
                          {l.ns_provider && <span style={{ fontWeight: 600, color: "#3f4a8f" }}>{l.ns_provider}</span>}
                          <span title={l.nameservers.join("\n")} style={{ display: "block", fontSize: 11, color: "#9a9aac", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {l.nameservers.join(", ")}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: "#b8b8c4" }}>none</span>
                      )
                    ) : (
                      <span style={{ color: "#c8c8d2" }}>…</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.sold ? (
                      <span style={{ color: "#2f7d4f", fontWeight: 600 }}>
                        Sold {r.sold_for ? usd(r.sold_for) : ""}
                        {r.sale_date && <span style={{ display: "block", fontSize: 11, color: "#8a8a98", fontWeight: 400 }}>{r.sale_date}</span>}
                      </span>
                    ) : r.on_marketplace ? (
                      <span style={{ color: "#875428" }}>Marketplace</span>
                    ) : (
                      <span style={{ color: "#6b6b7b" }}>Owned</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && !filtered.length && <tr><td style={{ ...td, textAlign: "center", color: "#6b6b7b" }} colSpan={11}>No names match.</td></tr>}
          </tbody>
        </table>
      </div>
      {s && <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>Generated {new Date(s.generatedAt).toLocaleString()} · Registrar/nameservers resolved live (cached 24h in your browser). Platform = where the sheet says it&apos;s listed.</p>}
    </main>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d5d5e0", borderRadius: 8, overflow: "hidden" }}>
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} style={{ padding: "7px 12px", border: "none", borderLeft: options[0][0] === v ? "none" : "1px solid #ececf2", background: value === v ? "#2f2f45" : "#fff", color: value === v ? "#fff" : "#44445a", cursor: "pointer", fontSize: 12.5, fontWeight: value === v ? 600 : 500 }}>
          {label}
        </button>
      ))}
    </div>
  );
}
