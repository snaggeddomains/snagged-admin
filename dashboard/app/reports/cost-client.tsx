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
type Preset = "today" | "week" | "month" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "custom", label: "Custom range" },
];

// Every meter the system can emit — so the rate card lists them for pricing even
// before they've been used. Merged with whatever's actually been seen/saved.
const RATE_CATALOG: string[] = [
  // Contact / data lookups (research)
  "rocketreach.lookup", "fullenrich.enrich", "fullenrich.phone",
  "domainiq.lookup", "whoisxml.lookup", "whoisxml.reverse_whois",
  "whoisxml.reverse_ns", "whoisxml.reverse_ip", "bigdomaindata.lookup",
  "whoxy.history", "whoxy.reverse", "serper.web_search", "serper.namepros",
  "brave.search", "signa.trademark", "namebio.sales", "appraise.new", "appraise.cached",
  // Pipeline scrapers
  "scrape_do.request", "cloudflare.browser_render", "dynadot.api", "namesilo.api", "spaceship.api",
  // Anthropic — research (Opus 4.7/4.8) + outreach (Sonnet 4.6) + enrichment (Haiku 4.5), per 1M tokens
  "anthropic.claude-opus-4-7.input", "anthropic.claude-opus-4-7.output",
  "anthropic.claude-opus-4-7.cache_read", "anthropic.claude-opus-4-7.cache_write",
  "anthropic.claude-opus-4-8.input", "anthropic.claude-opus-4-8.output",
  "anthropic.claude-opus-4-8.cache_read", "anthropic.claude-opus-4-8.cache_write",
  "anthropic.claude-sonnet-4-6.input", "anthropic.claude-sonnet-4-6.output",
  "anthropic.claude-sonnet-4-6.cache_read", "anthropic.claude-sonnet-4-6.cache_write",
  "anthropic.claude-haiku-4-5-20251001.input", "anthropic.claude-haiku-4-5-20251001.output",
  "anthropic.claude-haiku-4-5-20251001.cache_read", "anthropic.claude-haiku-4-5-20251001.cache_write",
];

// Best-estimate $/unit to prefill the rate card. Anthropic + Whoxy are published
// list prices; the rest are rough ballparks to adjust to your actual contracts.
// Dynadot/NameSilo/Spaceship APIs are free for account holders → 0.
const DEFAULT_RATES: Record<string, number> = {
  // Anthropic published list ($ / 1M tokens). Opus 4.x dropped to $5/$25 as of
  // Opus 4.5 (was $15/$75 on 4.1 and earlier) — keep these in sync with the
  // platform.claude.com pricing table.
  "anthropic.claude-opus-4-7.input": 5, "anthropic.claude-opus-4-7.output": 25,
  "anthropic.claude-opus-4-7.cache_read": 0.5, "anthropic.claude-opus-4-7.cache_write": 6.25,
  "anthropic.claude-opus-4-8.input": 5, "anthropic.claude-opus-4-8.output": 25,
  "anthropic.claude-opus-4-8.cache_read": 0.5, "anthropic.claude-opus-4-8.cache_write": 6.25,
  "anthropic.claude-sonnet-4-6.input": 3, "anthropic.claude-sonnet-4-6.output": 15,
  "anthropic.claude-sonnet-4-6.cache_read": 0.3, "anthropic.claude-sonnet-4-6.cache_write": 3.75,
  "anthropic.claude-haiku-4-5-20251001.input": 1, "anthropic.claude-haiku-4-5-20251001.output": 5,
  "anthropic.claude-haiku-4-5-20251001.cache_read": 0.1, "anthropic.claude-haiku-4-5-20251001.cache_write": 1.25,
  // Contact / data lookups ($ / call) — ESTIMATES
  "rocketreach.lookup": 0.5, "fullenrich.enrich": 0.1, "fullenrich.phone": 1.0,
  "domainiq.lookup": 0.3, "whoisxml.lookup": 0.005, "whoisxml.reverse_whois": 0.02,
  "whoisxml.reverse_ns": 0.02, "whoisxml.reverse_ip": 0.02, "bigdomaindata.lookup": 0.01,
  "whoxy.history": 0.005, "whoxy.reverse": 0.01, "serper.web_search": 0.001,
  "serper.namepros": 0.001, "brave.search": 0.004, "signa.trademark": 0.01,
  "namebio.sales": 0.02, "appraise.new": 0.3, "appraise.cached": 0.1,
  // Pipeline scrapers ($ / request) — ESTIMATES; the registrar APIs are free
  "scrape_do.request": 0.005, "cloudflare.browser_render": 0.01,
  "dynadot.api": 0, "namesilo.api": 0, "spaceship.api": 0,
};

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
// YYYY-MM-DD as the Eastern-Time calendar day (en-CA gives ISO order; the tz
// makes "today"/"yesterday" track ET, matching the server's ET buckets).
const etYmd = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
// Fixed column widths shared by the By-category and By-system tables so their
// Cost / Share columns line up across both.
const COLS_NAME_COST_SHARE = (
  <colgroup><col /><col style={{ width: 150 }} /><col style={{ width: 90 }} /></colgroup>
);
const FIXED_TABLE = { tableLayout: "fixed" as const, width: "100%" };
const TODAY = etYmd(new Date());
const YESTERDAY = etYmd(new Date(Date.now() - 86400000));
const WEEK_START = etYmd(new Date(Date.now() - 6 * 86400000)); // last 7 days incl. today
const MONTH_START = `${TODAY.slice(0, 7)}-01`;                  // 1st of the current month (ET)

export default function ReportsClient({ canCost, canEditRates, canAnalytics = false }: { canCost: boolean; canEditRates: boolean; canAnalytics?: boolean }) {
  const [period, setPeriod] = useState<Period>("day");
  const [preset, setPreset] = useState<Preset>("week");
  const [from, setFrom] = useState(WEEK_START); // custom-range start
  const [to, setTo] = useState(TODAY);          // custom-range end
  const [category, setCategory] = useState<string>("All");

  // Resolve the active preset → an ET [from, to] day range (all four options,
  // including custom, run through the same ET date-range path).
  const range = useMemo(() => {
    if (preset === "today") return { from: TODAY, to: TODAY };
    if (preset === "week") return { from: WEEK_START, to: TODAY };
    if (preset === "month") return { from: MONTH_START, to: TODAY };
    return { from, to: to || from };
  }, [preset, from, to]);
  const [totals, setTotals] = useState<Total[]>([]);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [allMeters, setAllMeters] = useState<string[]>([]);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const [newMeter, setNewMeter] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string>("");
  const [dirty, setDirty] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setMsg("");
    try {
      const q = new URLSearchParams({ period, from: range.from, to: range.to });
      if (category !== "All") q.set("category", category);
      const res = await fetch(`/api/admin/reports?${q.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
      setTotals(data.totals || []);
      setSeries(data.series || []);
      setAllMeters(data.allMeters || []);
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
  }, [period, category, range.from, range.to]);

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

  // Every meter to show in the editable Rate card: the known catalog ∪ anything
  // ever logged ∪ anything already priced — so you can set rates before use.
  const rateMeters = useMemo(() => {
    const set = new Set<string>([...RATE_CATALOG, ...allMeters, ...Object.keys(rates), ...totals.map((t) => t.meter)]);
    return Array.from(set).sort();
  }, [allMeters, rates, totals]);

  function setRate(meter: string, value: string) {
    const n = Number(value);
    setRates((r) => ({ ...r, [meter]: Number.isFinite(n) ? n : 0 }));
    setDirty((d) => new Set(d).add(meter));
  }
  function setLabel(meter: string, value: string) {
    setLabels((l) => ({ ...l, [meter]: value }));
    setDirty((d) => new Set(d).add(meter));
  }
  function addMeter() {
    const m = newMeter.trim();
    if (!m) return;
    setRates((r) => ({ ...r, [m]: r[m] ?? 0 }));
    setDirty((d) => new Set(d).add(m));
    setNewMeter("");
  }
  // Drop best-estimate defaults into any meter that isn't priced yet (won't
  // overwrite a rate you've already set). Review, then Save to persist.
  function prefillEstimates() {
    const next = { ...rates };
    const d = new Set(dirty);
    for (const m of rateMeters) {
      if ((next[m] ?? 0) === 0 && DEFAULT_RATES[m] !== undefined) {
        next[m] = DEFAULT_RATES[m];
        d.add(m);
      }
    }
    setRates(next);
    setDirty(d);
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
          You have Reports access but not the cost report. Ask an admin for the{" "}
          <code>reports.cost</code> permission.
        </p>
      </main>
    );
  }

  const presetLabel = PRESETS.find((p) => p.key === preset)?.label.toLowerCase() ?? "";
  const rangeLabel = preset === "custom"
    ? (range.from === range.to ? range.from : `${range.from} → ${range.to}`)
    : presetLabel;
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
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
            className="field" style={{ padding: "5px 8px", fontSize: 13 }}
          >
            {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        {preset === "custom" && (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="date" value={from} max={to || TODAY} onChange={(e) => setFrom(e.target.value)}
              className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
            <span className="muted">→</span>
            <input type="date" value={to} max={TODAY} min={from} onChange={(e) => setTo(e.target.value)}
              className="field" style={{ padding: "4px 6px", fontSize: 13 }} />
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
            <h2 style={{ fontSize: 18 }}>By category</h2>
            <p className="section-blurb" style={{ marginTop: 0 }}>What each activity / product costs — e.g. auctions vs snap pipeline vs domain-owner reports.</p>
            <div className="table-scroll"><table className="dash" style={FIXED_TABLE}>
              {COLS_NAME_COST_SHARE}
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
            <h2 style={{ fontSize: 18 }}>By system {category !== "All" && <span className="muted">· {category}</span>}</h2>
            <div className="table-scroll"><table className="dash" style={FIXED_TABLE}>
              {COLS_NAME_COST_SHARE}
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
            <h2 style={{ fontSize: 18 }}>By meter {category !== "All" && <span className="muted">· {category}</span>}</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>meter</th><th className="right">usage</th><th className="right">rate</th><th className="right">cost</th></tr></thead>
              <tbody>
                {perMeter.map((m) => (
                  <tr key={m.meter}>
                    <td className="mono">{m.meter}<div className="muted" style={{ fontSize: 11 }}>{labels[m.meter] || defaultLabel(m.meter)}</div></td>
                    <td className="right">{num(m.units)}</td>
                    <td className="right muted">{(rates[m.meter] ?? 0) ? usd(rates[m.meter]) : "—"}</td>
                    <td className="right">{usd(m.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Rates are set in the editable Rate card at the bottom of the page.</p>
          </section>

          <section style={{ marginTop: 20 }}>
            <h2 style={{ fontSize: 18 }}>Over time ({period}){category !== "All" && <span className="muted"> · {category}</span>}</h2>
            <div className="table-scroll"><table className="dash">
              <thead><tr><th>{period === "month" ? "month" : period === "week" ? "week of" : "day"}</th><th className="right">cost</th></tr></thead>
              <tbody>
                {series.map((s) => (
                  <tr key={s.bucket}><td className="mono">{s.bucket}</td><td className="right">{usd(s.cost)}</td></tr>
                ))}
              </tbody>
            </table></div>
            <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>Time series uses your saved rates — Save in the Rate card below to refresh it.</p>
          </section>
        </>
      )}

      {/* Editable rate card — the single place to price every source (admin only). */}
      <section style={{ marginTop: 28, paddingTop: 16, borderTop: "1px solid #e3ddcf" }}>
        <h2 style={{ fontSize: 18 }}>Rate card — $ per unit</h2>
        <p className="section-blurb" style={{ marginTop: 0 }}>
          Set what each source costs you — no SQL needed. Token meters are priced
          per <strong>1M tokens</strong>; everything else per <strong>call / lookup / enrichment</strong>.
          Saved rates apply across all categories and drive every dollar figure above.
          Use <strong>Prefill estimates</strong> for a starting point (Anthropic &amp; Whoxy
          are list prices; the rest are ballparks to adjust), then Save.
        </p>
        <div className="table-scroll"><table className="dash">
          <thead><tr><th>meter</th><th>unit</th><th className="right">$ / unit</th></tr></thead>
          <tbody>
            {rateMeters.map((m) => (
              <tr key={m}>
                <td className="mono">{m}</td>
                <td>
                  {canEditRates ? (
                    <input
                      type="text" value={labels[m] ?? defaultLabel(m)}
                      onChange={(e) => setLabel(m, e.target.value)}
                      style={{ width: 150, padding: "3px 6px", fontSize: 13, border: "1px solid #e3ddcf", borderRadius: 6 }}
                    />
                  ) : <span className="muted">{labels[m] ?? defaultLabel(m)}</span>}
                </td>
                <td className="right">
                  {canEditRates ? (
                    <input
                      type="number" step="any" min="0" value={rates[m] ?? 0}
                      onChange={(e) => setRate(m, e.target.value)}
                      style={{ width: 120, textAlign: "right", padding: "3px 6px", fontSize: 13, border: "1px solid #e3ddcf", borderRadius: 6 }}
                    />
                  ) : usd(rates[m] ?? 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {canEditRates ? (
          <div style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="text" placeholder="add a meter (e.g. vendor.action)" value={newMeter}
              onChange={(e) => setNewMeter(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addMeter(); }}
              className="field" style={{ maxWidth: 240, fontSize: 13 }}
            />
            <button onClick={addMeter} disabled={!newMeter.trim()} style={{ fontSize: 13 }}>Add meter</button>
            <button onClick={prefillEstimates} style={{ fontSize: 13 }}>Prefill estimates</button>
            <button onClick={saveRates} disabled={saving || dirty.size === 0} className="btn btn--navy">
              {saving ? "Saving…" : dirty.size ? `Save ${dirty.size} change${dirty.size > 1 ? "s" : ""}` : "Saved"}
            </button>
            {msg && <span style={{ fontSize: 13, color: msg.includes("saved") ? "#2a7" : "var(--coral-deep, #c0492f)" }}>{msg}</span>}
          </div>
        ) : (
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Rates are read-only — only an admin can change them.</p>
        )}
      </section>
    </main>
  );
}
