"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type SnapName = {
  domain: string;
  source: "Berserk" | "SNAP" | "Rob";
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
  premium: string | null;
  active: string | null;
  notes: string | null;
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

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

const SOURCE_STYLE: Record<string, { name: string; bg: string; fg: string }> = {
  Berserk: { name: "Berserk", bg: "#f1e7dc", fg: "#875428" },
  SNAP: { name: "SNAP", bg: "#e2efe5", fg: "#2f7d4f" },
  Rob: { name: "Rob", bg: "#e6e8f5", fg: "#3f4a8f" },
};
function SourcePill({ source }: { source: string }) {
  const s = SOURCE_STYLE[source] || { name: source, bg: "#eee", fg: "#333" };
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>
      {s.name}
    </span>
  );
}

const card: CSSProperties = { border: "1px solid #e6e6ef", borderRadius: 12, padding: "14px 16px", background: "#fff" };
const th: CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 12, color: "#6b6b7b", fontWeight: 600, borderBottom: "1px solid #e6e6ef", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" };
const td: CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid #f0f0f5", verticalAlign: "top" };

type SortKey = "domain" | "source" | "date" | "purchase" | "internal" | "spaceship" | "status";

export default function SnapNamesClient() {
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"all" | "Berserk" | "SNAP" | "Rob">("all");
  const [status, setStatus] = useState<"all" | "owned" | "sold" | "marketplace">("all");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

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

  const filtered = useMemo(() => {
    if (!report) return [];
    const needle = q.trim().toLowerCase();
    let rows = report.rows.filter((r) => {
      if (src !== "all" && r.source !== src) return false;
      if (status === "owned" && r.sold) return false;
      if (status === "sold" && !r.sold) return false;
      if (status === "marketplace" && !r.on_marketplace) return false;
      if (needle && !r.domain.includes(needle) && !(r.platform || "").toLowerCase().includes(needle)) return false;
      return true;
    });
    const val = (r: SnapName): string | number => {
      switch (sortKey) {
        case "domain": return r.domain;
        case "source": return r.source;
        case "date": return r.date_purchased ? Date.parse(r.date_purchased) || 0 : 0;
        case "purchase": return r.purchase_price ?? -1;
        case "internal": return r.internal_price ?? -1;
        case "spaceship": return r.spaceship_price ?? -1;
        case "status": return r.sold ? 2 : r.on_marketplace ? 1 : 0;
        default: return 0;
      }
    };
    rows = [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return 0;
    });
    return rows;
  }, [report, q, src, status, sortKey, sortDir]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "domain" || k === "source" ? 1 : -1);
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === 1 ? " ▲" : " ▼") : "");

  const downloadCsv = () => {
    const cols: (keyof SnapName)[] = ["domain", "source", "tld", "date_purchased", "purchase_price", "internal_price", "spaceship_price", "atom_price", "on_marketplace", "platform", "still_owned", "sold_for", "sale_date", "premium", "active", "notes"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of filtered) lines.push(cols.map((c) => esc(r[c])).join(","));
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
    <main style={{ maxWidth: "var(--maxw, 1180px)", margin: "0 auto", padding: "0 4px" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>SNAP Names</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every domain we&apos;ve purchased / hold for sale, aggregated across the SNAP + Rob purchase trackers.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={downloadCsv} disabled={!filtered.length} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            ⬇ CSV
          </button>
          <button onClick={load} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {err && (
        <div style={{ ...card, marginTop: 16, borderColor: "#f0c0c0", background: "#fdf3f3", color: "#a33" }}>{err}</div>
      )}

      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 16 }}>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Total names</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.total}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Still owned</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.owned}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Sold</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.sold}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>On marketplace</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.on_marketplace}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Internal value (owned)</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_internal_value)}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Total sold for</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_sold_for)}</div></div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 18 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search domain / registrar…"
          style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13, minWidth: 220 }}
        />
        <Segmented value={src} onChange={(v) => setSrc(v as typeof src)} options={[["all", "All sources"], ["SNAP", "SNAP"], ["Rob", "Rob"], ["Berserk", "Berserk"]]} />
        <Segmented value={status} onChange={(v) => setStatus(v as typeof status)} options={[["all", "All"], ["owned", "Owned"], ["sold", "Sold"], ["marketplace", "On marketplace"]]} />
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>{filtered.length} shown</span>
      </div>

      <div style={{ ...card, marginTop: 12, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 920 }}>
          <thead>
            <tr>
              <th style={th} onClick={() => setSort("domain")}>Domain{arrow("domain")}</th>
              <th style={th} onClick={() => setSort("source")}>Source{arrow("source")}</th>
              <th style={th} onClick={() => setSort("date")}>Purchased{arrow("date")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("purchase")}>Cost{arrow("purchase")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("internal")}>Internal{arrow("internal")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("spaceship")}>Spaceship{arrow("spaceship")}</th>
              <th style={th}>Atom</th>
              <th style={th}>Registrar</th>
              <th style={th} onClick={() => setSort("status")}>Status{arrow("status")}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => (
              <tr key={`${r.source}-${r.domain}-${i}`}>
                <td style={{ ...td, fontWeight: 600 }}>
                  {r.domain}
                  {r.notes && <span title={r.notes} style={{ marginLeft: 6, cursor: "help", opacity: 0.6 }}>📝</span>}
                </td>
                <td style={td}><SourcePill source={r.source} /></td>
                <td style={{ ...td, whiteSpace: "nowrap", color: "#6b6b7b" }}>{r.date_purchased || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>{usd(r.purchase_price)}</td>
                <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{usd(r.internal_price)}</td>
                <td style={{ ...td, textAlign: "right", color: "#6b6b7b" }}>{usd(r.spaceship_price)}</td>
                <td style={{ ...td, color: "#6b6b7b", whiteSpace: "nowrap" }}>{r.atom_price || "—"}</td>
                <td style={{ ...td, color: "#6b6b7b", whiteSpace: "nowrap" }}>{r.platform || "—"}</td>
                <td style={td}>
                  {r.sold ? (
                    <span style={{ color: "#2f7d4f", fontWeight: 600 }}>Sold {r.sold_for ? usd(r.sold_for) : ""}</span>
                  ) : r.on_marketplace ? (
                    <span style={{ color: "#875428" }}>Marketplace</span>
                  ) : (
                    <span style={{ color: "#6b6b7b" }}>Owned</span>
                  )}
                </td>
              </tr>
            ))}
            {!loading && !filtered.length && (
              <tr><td style={{ ...td, textAlign: "center", color: "#6b6b7b" }} colSpan={9}>No names match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {s && <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>Generated {new Date(s.generatedAt).toLocaleString()} · V1 pulls directly from the trackers. V2 will live-check Spaceship / marketplace / registrar / nameservers.</p>}
    </main>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d5d5e0", borderRadius: 8, overflow: "hidden" }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: "7px 12px",
            border: "none",
            borderLeft: options[0][0] === v ? "none" : "1px solid #ececf2",
            background: value === v ? "#2f2f45" : "#fff",
            color: value === v ? "#fff" : "#44445a",
            cursor: "pointer",
            fontSize: 12.5,
            fontWeight: value === v ? 600 : 500,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
