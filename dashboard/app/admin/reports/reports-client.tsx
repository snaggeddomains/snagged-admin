"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Period = "day" | "week" | "month";
type Total = { category: string; meter: string; units: number };
type SeriesPoint = { bucket: string; cost: number };
type Rate = { meter: string; usd_per_unit: number; unit_label: string | null };

const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];
const WINDOWS = [7, 30, 90, 365];

// "fullenrich.phone" → "fullenrich"; "anthropic.claude-opus-4-7.input" → "anthropic".
function systemOf(meter: string): string {
  return meter.split(".")[0] || meter;
}
function defaultLabel(meter: string): string {
  if (/\.(input|output|cache_read|cache_write|batch_input|batch_output)$/.test(meter)) return "$ / 1M tokens";
  if (meter.endsWith(".phone")) return "$ / phone";
  if (meter.endsWith(".enrich")) return "$ / enrichment";
  if (meter.includes("scrape") || meter.includes("browser_render")) return "$ / request";
  return "$ / call";
}
const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 }));
// YYYY-MM-DD in UTC (matches the server's UTC day buckets).
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const TODAY = ymd(new Date());
const YESTERDAY = ymd(new Date(Date.now() - 86400000));

export default function ReportsClient({ canCost }: { canCost: boolean }) {
  const [period, setPeriod] = useState<Period>("day");
  const [days, setDays] = useState(30);
  const [mode, setMode] = useState<"preset" | "custom">("preset");
  const [from, setFrom] = useState(YESTERDAY);
  const [to, setTo] = useState(TODAY);
  const [category, setCategory] = useState<string>("All");
  const [totals, setTotals] = useState<Total[]>([]);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ period });
      if (mode === "custom" && from) {
        q.set("from", from);
        q.set("to", to || from);
      } else {
        q.set("days", String(days));
      }
      if (category !== "All") q.set("category", category);
      const res = await fetch(`/api/admin/reports?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setTotals(data.totals || []);
      setSeries(data.series || []);
      const r: Record<string, number> = {};
      const l: Record<string, string | null> = {};
      for (const row of (data.rates || []) as Rate[]) {
        r[row.meter] = row.usd_per_unit;
        l[row.meter] = row.unit_label;
      }
      setRates(r);
      setLabels(l);
      setDirty(new Set());
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [period, days, category, mode, from, to]);

  useEffect(() => {
    if (canCost) load();
  }, [load, canCost]);

  const rate = useCallback((m: string) => rates[m] ?? 0, [rates]);

  const { categories, byCategory, filtered, bySystem, perMeter, grand } = useMemo(() => {
    const cats = Array.from(new Set(totals.map((t) => t.category))).sort();
    // By category uses ALL rows (the comparison the report is for); the rest
    // respect the category filter so you can drill into one.
    const catCost = new Map<string, number>();
    for (const t of totals) catCost.set(t.category, (catCost.get(t.category) || 0) + t.units * rate(t.meter));
    const byCat = Array.from(catCost.entries()).map(([c, cost]) => ({ category: c, cost })).sort((a, b) => b.cost - a.cost);

    const rows = category === "All" ? totals : totals.filter((t) => t.category === category);
    const sysCost = new Map<string, number>();
    const meterUnits = new Map<string, number>();
    let g = 0;
    for (const t of rows) {
      const c = t.units * rate(t.meter);
      sysCost.set(systemOf(t.meter), (sysCost.get(systemOf(t.meter)) || 0) + c);
      meterUnits.set(t.meter, (meterUnits.get(t.meter) || 0) + t.units);
      g += c;
    }
    const sys = Array.from(sysCost.entries()).map(([system, cost]) => ({ system, cost })).sort((a, b) => b.cost - a.cost);
    const meters = Array.from(meterUnits.keys()).sort().map((m) => {
      const units = meterUnits.get(m) || 0;
      return { meter: m, units, cost: units * rate(m) };
    });
    return { categories: cats, byCategory: byCat, filtered: rows, bySystem: sys, perMeter: meters, grand: g };
  }, [totals, rates, category, rate]);

  function setRate(meter: string, value: string) {
    const n = Number(value);
    setRates((r) => ({ ...r, [meter]: Number.isFinite(n) ? n : 0 }));
    setDirty((d) => new Set(d).add(meter));
  }

  async function saveRates() {
    setSaving(true);
    setMsg("");
    try {
      for (const meter of dirty) {
        const res = await fetch("/api/admin/reports", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ meter, usd_per_unit: rates[meter] ?? 0, unit_label: labels[meter] ?? defaultLabel(meter) }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `Save failed for ${meter}`);
        }
      }
      setDirty(new Set());
      await load(); // refresh the server-computed time series with the new rates
      setMsg("Rates saved.");
    } catch (e) {
      setMsg(String((e as Error).message || e));
    } finally {
      setSaving(false);
    }
  }

  if (!canCost) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>Reports</h1>
        <p className="muted">
          You have the Reports tab but not the cost report. Ask an admin for the{" "}
          <code>admin.reports.cost</code> permission.
        </p>
      </main>
    );
  }

  const rangeLabel = mode === "custom" && from ? (from === (to || from) ? from : `${from} → ${to || from}`) : `last ${days}d`;
  const filterNote = category === "All" ? rangeLabel : `· ${category} · ${rangeLabel}`;

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>API cost &amp; usage</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        What each system and activity is costing. Set a dollar rate per meter
        below — cost = usage × your rate. Usage is logged per paid call across the
        research app (domain-owner reports, naming, outreach, …) and the pipeline
        (auctions, snap, enrichment).
      </p>

      <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap", margin: "16px 0" }}>
        <div style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3 }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{
                padding: "5px 12px", fontSize: 13, fontWeight: 700, borderRadius: 6, border: "none", cursor: "pointer",
                background: period === p.key ? "var(--navy, #254254)" : "transparent",
                color: period === p.key ? "#fff" : "var(--navy, #254254)",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          Window
          <select
            value={mode === "custom" ? "custom" : String(days)}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") setMode("custom");
              else { setMode("preset"); setDays(Number(v)); }
            }}
            className="field" style={{ padding: "5px 8px", fontSize: 13 }}
          >
            {WINDOWS.map((w) => <option key={w} value={w}>last {w} days</option>)}
            <option value="custom">Custom range…</option>
          </select>
        </label>
        {mode === "custom" && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)}
              className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)}
              className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
            <button onClick={() => { setFrom(YESTERDAY); setTo(YESTERDAY); }} style={{ fontSize: 12 }}>Yesterday</button>
            <button onClick={() => { setFrom(TODAY); setTo(TODAY); }} style={{ fontSize: 12 }}>Today</button>
          </span>
        )}
        <label style={{ fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="field" style={{ padding: "5px 8px", fontSize: 13 }}>
            <option value="All">All</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        <span style={{ marginLeft: "auto", fontSize: 22, fontWeight: 800, color: "var(--navy, #254254)" }}>
          {usd(grand)} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{filterNote}</span>
        </span>
      </div>

      {msg && <p style={{ fontSize: 13, color: msg.includes("saved") ? "#2a7" : "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      {totals.length === 0 && !loading ? (
        <p className="muted">No usage recorded in this window yet. Once research runs or a pipeline source runs (and the migrations are applied), spend shows up here.</p>
      ) : (
        <>
          <section style={{ marginTop: 8 }}>
            <h2 style={{ fontSize: 14 }}>By category</h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>What each activity / product costs — e.g. auctions vs snap pipeline vs domain-owner reports.</p>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>category</th><th className="right">cost</th><th className="right">share</th></tr></thead>
              <tbody>
                {byCategory.map((c) => {
                  const all = byCategory.reduce((s, x) => s + x.cost, 0);
                  return (
                    <tr key={c.category}>
                      <td className="mono">{c.category}</td>
                      <td className="right">{usd(c.cost)}</td>
                      <td className="right muted">{all > 0 ? `${Math.round((c.cost / all) * 100)}%` : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>By system {category !== "All" && <span className="muted">· {category}</span>}</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>system</th><th className="right">cost</th><th className="right">share</th></tr></thead>
              <tbody>
                {bySystem.map((s) => (
                  <tr key={s.system}>
                    <td className="mono">{s.system}</td>
                    <td className="right">{usd(s.cost)}</td>
                    <td className="right muted">{grand > 0 ? `${Math.round((s.cost / grand) * 100)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>By meter — set your rate {category !== "All" && <span className="muted">· {category}</span>}</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>meter</th><th className="right">usage</th><th className="right">rate</th><th className="right">cost</th></tr></thead>
              <tbody>
                {perMeter.map((m) => (
                  <tr key={m.meter}>
                    <td className="mono">{m.meter}<div className="muted" style={{ fontSize: 11 }}>{labels[m.meter] || defaultLabel(m.meter)}</div></td>
                    <td className="right">{num(m.units)}</td>
                    <td className="right">
                      <input
                        type="number" step="any" min="0" value={rates[m.meter] ?? 0}
                        onChange={(e) => setRate(m.meter, e.target.value)}
                        style={{ width: 110, textAlign: "right", padding: "3px 6px", fontSize: 13, border: "1px solid #e3ddcf", borderRadius: 6 }}
                      />
                    </td>
                    <td className="right">{usd(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={saveRates} disabled={saving || dirty.size === 0} className="btn btn--navy">
                {saving ? "Saving…" : dirty.size ? `Save ${dirty.size} rate${dirty.size > 1 ? "s" : ""}` : "Saved"}
              </button>
              <span className="muted" style={{ fontSize: 12 }}>Token meters are priced per 1M tokens; lookups/enrichments per call. Rates are global (not per-category).</span>
            </div>
          </section>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>Over time ({period}){category !== "All" && <span className="muted"> · {category}</span>}</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>{period === "month" ? "month" : period === "week" ? "week of" : "day"}</th><th className="right">cost</th></tr></thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.bucket}><td className="mono">{s.bucket}</td><td className="right">{usd(s.cost)}</td></tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Time series uses your saved rates — Save above to refresh it.</p>
          </section>
        </>
      )}
    </main>
  );
}
