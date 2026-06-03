"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Period = "day" | "week" | "month";
type Bucket = { bucket: string; meter: string; units: number };
type Rate = { meter: string; usd_per_unit: number; unit_label: string | null };

const PERIODS: { key: Period; label: string }[] = [
  { key: "day", label: "Daily" },
  { key: "week", label: "Weekly" },
  { key: "month", label: "Monthly" },
];
const WINDOWS = [7, 30, 90, 365];

// Group key for the rollup: the part before the first dot ("fullenrich.phone" →
// "fullenrich", "anthropic.claude-opus-4-7.input" → "anthropic").
function systemOf(meter: string): string {
  return meter.split(".")[0] || meter;
}
// Sensible default unit label when the admin hasn't set one.
function defaultLabel(meter: string): string {
  if (/\.(input|output|cache_read|cache_write)$/.test(meter)) return "$ / 1M tokens";
  if (meter.endsWith(".phone")) return "$ / phone";
  if (meter.endsWith(".enrich")) return "$ / enrichment";
  return "$ / call";
}
const usd = (n: number) =>
  n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const num = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 3 }));

export default function ReportsClient({ canCost }: { canCost: boolean }) {
  const [period, setPeriod] = useState<Period>("day");
  const [days, setDays] = useState(30);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
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
      const res = await fetch(`/api/admin/reports?period=${period}&days=${days}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setBuckets(data.buckets || []);
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
  }, [period, days]);

  useEffect(() => {
    if (canCost) load();
  }, [load, canCost]);

  // Aggregate buckets → per-meter totals, per-system rollup, and a time series.
  const { meters, perMeter, perSystem, series, grand } = useMemo(() => {
    const meterUnits = new Map<string, number>();
    const byBucket = new Map<string, number>(); // bucket → $ total
    const sysCost = new Map<string, number>();
    let grandTotal = 0;
    for (const b of buckets) {
      meterUnits.set(b.meter, (meterUnits.get(b.meter) || 0) + b.units);
      const cost = b.units * (rates[b.meter] ?? 0);
      byBucket.set(b.bucket, (byBucket.get(b.bucket) || 0) + cost);
      sysCost.set(systemOf(b.meter), (sysCost.get(systemOf(b.meter)) || 0) + cost);
      grandTotal += cost;
    }
    const meterList = Array.from(meterUnits.keys()).sort();
    const perMeterRows = meterList.map((m) => {
      const units = meterUnits.get(m) || 0;
      return { meter: m, units, rate: rates[m] ?? 0, cost: units * (rates[m] ?? 0) };
    });
    const perSystemRows = Array.from(sysCost.entries())
      .map(([system, cost]) => ({ system, cost }))
      .sort((a, b) => b.cost - a.cost);
    const seriesRows = Array.from(byBucket.entries())
      .map(([bucket, cost]) => ({ bucket, cost }))
      .sort((a, b) => (a.bucket < b.bucket ? 1 : -1));
    return { meters: meterList, perMeter: perMeterRows, perSystem: perSystemRows, series: seriesRows, grand: grandTotal };
  }, [buckets, rates]);

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

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>API cost &amp; usage</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        What the research pipeline is spending per system. Set a dollar rate per
        meter below — cost = usage × your rate. Usage is logged per paid call
        (FullEnrich, RocketReach, DomainIQ, Whoxy, search, Anthropic tokens, …).
      </p>

      {/* Controls */}
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
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="field" style={{ padding: "5px 8px", fontSize: 13 }}>
            {WINDOWS.map((w) => <option key={w} value={w}>last {w} days</option>)}
          </select>
        </label>
        <button onClick={load} disabled={loading} style={{ fontSize: 13 }}>{loading ? "Loading…" : "Refresh"}</button>
        <span style={{ marginLeft: "auto", fontSize: 22, fontWeight: 800, color: "var(--navy, #254254)" }}>
          {usd(grand)} <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>over last {days}d</span>
        </span>
      </div>

      {msg && <p style={{ fontSize: 13, color: msg.includes("saved") ? "#2a7" : "var(--coral-deep, #c0492f)" }}>{msg}</p>}

      {buckets.length === 0 && !loading ? (
        <p className="muted">No usage recorded in this window yet. Once research runs (or the migration is applied), spend shows up here.</p>
      ) : (
        <>
          {/* By system */}
          <section style={{ marginTop: 8 }}>
            <h2 style={{ fontSize: 14 }}>By system</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>system</th><th className="right">cost</th><th className="right">share</th></tr></thead>
              <tbody>
                {perSystem.map((s) => (
                  <tr key={s.system}>
                    <td className="mono">{s.system}</td>
                    <td className="right">{usd(s.cost)}</td>
                    <td className="right muted">{grand > 0 ? `${Math.round((s.cost / grand) * 100)}%` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>

          {/* Per-meter usage + editable rate */}
          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>By meter — set your rate</h2>
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
              <span className="muted" style={{ fontSize: 12 }}>Token meters are priced per 1M tokens; lookups/enrichments per call.</span>
            </div>
          </section>

          {/* Over time */}
          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 14 }}>Over time ({period})</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>{period === "month" ? "month" : period === "week" ? "week of" : "day"}</th><th className="right">cost</th></tr></thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.bucket}><td className="mono">{s.bucket}</td><td className="right">{usd(s.cost)}</td></tr>
                ))}
              </tbody>
            </table></div>
          </section>
        </>
      )}
    </main>
  );
}
