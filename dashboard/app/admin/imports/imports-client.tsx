"use client";

import { useCallback, useEffect, useState } from "react";

type Target = "universe" | "master";
type Mode = "merge" | "replace";
type Row = { domain: string; price: number | null; owner: string | null };

type Preview = {
  parsed: number;
  invalid: number;
  existing: number;
  fresh: number;
  removed: number;
  sourceTotal: number;
};

type HistoryRow = {
  id?: string;
  target?: string;
  source?: string;
  mode?: string;
  parsed?: number;
  upserted?: number;
  removed?: number;
  backfilled?: boolean;
  user_email?: string | null;
  created_at?: string;
};

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const PRICE_RE = /^\$?[\d,]+(\.\d+)?$/;
const CHUNK = 1000;

// Parse pasted text OR a CSV file: one row per line, find the cell that looks
// like a domain, an optional numeric price cell, and (for Master) an optional
// owner cell — the first remaining non-empty text cell. Header/junk lines (no
// domain) are skipped, so it tolerates "name,listed price,owner" headers etc.
function parseRows(text: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(/[,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const domain = cells.find((c) => DOMAIN_RE.test(c));
    if (!domain) continue;
    const d = domain.toLowerCase();
    if (seen.has(d)) continue;
    seen.add(d);
    const priceCell = cells.find((c) => c !== domain && PRICE_RE.test(c));
    const price = priceCell ? Number(priceCell.replace(/[^0-9.]/g, "")) : null;
    // Owner = first remaining cell that isn't the domain, the price, or empty.
    const ownerCell = cells.find(
      (c) => c && c !== domain && c !== priceCell && !PRICE_RE.test(c) && !DOMAIN_RE.test(c),
    );
    out.push({
      domain: d,
      price: price != null && isFinite(price) ? price : null,
      owner: ownerCell || null,
    });
  }
  return out;
}

export default function ImportsClient({
  universeReady,
  masterReady,
}: {
  universeReady: boolean;
  masterReady: boolean;
}) {
  const [target, setTarget] = useState<Target>("universe");
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<Mode>("merge");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [autoBackfill, setAutoBackfill] = useState(true);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const add = (line: string) => setLog((l) => [...l, line]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/imports", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.history)) setHistory(data.history as HistoryRow[]);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
    setPreview(null);
    add(`Loaded file: ${f.name} (${(f.size / 1024).toFixed(0)} KB)`);
  }

  async function post(payload: Record<string, unknown>) {
    const res = await fetch("/api/admin/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function onPreview() {
    const src = source.trim();
    if (!src) { add("⚠️ Enter a source name first."); return; }
    const rows = parseRows(text);
    if (!rows.length) { add("⚠️ No valid domains found in the input."); return; }
    setPreviewing(true);
    setPreview(null);
    try {
      const data = await post({ action: "preview", target, source: src, rows, mode });
      setPreview(data.preview as Preview);
    } catch (e) {
      add(`❌ Preview: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPreviewing(false);
    }
  }

  async function run() {
    const src = source.trim();
    if (!src) { add("⚠️ Enter a source name first."); return; }
    const rows = parseRows(text);
    if (!rows.length) { add("⚠️ No valid domains found in the input."); return; }

    setBusy(true);
    setLog([]);
    const importTs = new Date().toISOString();
    const today = importTs.slice(0, 10);
    add(`Parsed ${rows.length.toLocaleString()} domains → ${target} (source "${src}", ${mode}).`);
    setProgress({ done: 0, total: rows.length });
    let upserted = 0;
    let removed = 0;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const data = await post({ action: "upsert", target, source: src, rows: chunk, importTs, today });
        upserted += data.upserted || 0;
        setProgress({ done: Math.min(i + CHUNK, rows.length), total: rows.length });
      }
      add(`✅ Upserted ${upserted.toLocaleString()} rows.`);

      if (mode === "replace") {
        add("Removing stale rows for this source…");
        const data = await post({ action: "finalize-replace", target, source: src, importTs, today });
        removed = Number(data.removed || 0);
        add(`🗑️ Removed ${removed.toLocaleString()} stale rows.`);
      }

      let backfilled = false;
      if (autoBackfill) {
        try {
          await post({ action: "post-backfill", target, source: src });
          backfilled = true;
          add(target === "universe"
            ? "🔧 Dispatched structural + quality backfill for new universe rows."
            : "🔧 Dispatched quality-score backfill for new Master rows.");
        } catch (e) {
          add(`⚠️ Backfill dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        add(target === "universe"
          ? "Done. Run “Backfill universe structural fields” to fill word/dictionary fields on new rows."
          : "Done.");
      }

      // Record the run in the import-history log (best-effort).
      await post({ action: "log", target, source: src, mode, parsed: rows.length, upserted, removed, backfilled }).catch(() => {});
      loadHistory();
    } catch (e) {
      add(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const targetReady = target === "universe" ? universeReady : masterReady;
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <main style={{ maxWidth: 760 }}>
      <h1 style={{ fontSize: "1.35rem", marginBottom: 2 }}>Imports</h1>
      <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
        Paste domains or upload a CSV to add them to a database. Merge keeps everything;
        Replace overwrites that source&apos;s inventory (drops names no longer in the file).
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 18 }}>
        <div>
          <Label>Target database</Label>
          <Seg
            value={target}
            onChange={(v) => { setTarget(v as Target); setPreview(null); }}
            options={[
              { v: "universe", label: "Universe (name_universe)" },
              { v: "master", label: "Master List" },
            ]}
          />
          {!targetReady && (
            <p style={{ color: "var(--coral-deep)", fontSize: 13, marginTop: 6 }}>
              Not configured — add {target === "universe" ? "SUPABASE_NAMING_*" : "MASTERLIST_SUPABASE_*"} env vars.
            </p>
          )}
        </div>

        <div>
          <Label>Source name</Label>
          <input
            className="field"
            placeholder="e.g. brandbucket"
            value={source}
            onChange={(e) => { setSource(e.target.value); setPreview(null); }}
            style={{ maxWidth: 320 }}
          />
        </div>

        <div>
          <Label>Mode</Label>
          <Seg
            value={mode}
            onChange={(v) => { setMode(v as Mode); setPreview(null); }}
            options={[
              { v: "merge", label: "Merge (add / update)" },
              { v: "replace", label: "Replace this source" },
            ]}
          />
          {mode === "replace" && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              Upserts the file, then deletes rows of this source not in it. Use for full
              snapshots (e.g. a monthly dump).
            </p>
          )}
        </div>

        <div>
          <Label>Domains (paste) or upload CSV</Label>
          <textarea
            className="field"
            rows={8}
            placeholder={"example.com\nbobby.com, 1995\n…or upload a CSV below"}
            value={text}
            onChange={(e) => { setText(e.target.value); setPreview(null); }}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
          />
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} style={{ marginTop: 8 }} />
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            One per line. A domain cell + optional price{target === "master" ? " + owner" : ""} are
            auto-detected; headers are ignored.
          </span>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer" }}>
          <input type="checkbox" checked={autoBackfill} onChange={(e) => setAutoBackfill(e.target.checked)} />
          Auto-run {target === "universe" ? "structural + quality" : "quality-score"} backfill after import
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" onClick={onPreview} disabled={busy || previewing || !targetReady}
            style={{ border: "1.5px solid #d9d2c2", background: "#fff", color: "var(--navy)" }}>
            {previewing ? "Previewing…" : "Preview"}
          </button>
          <button className="btn btn--navy" onClick={run} disabled={busy || !targetReady}>
            {busy ? "Importing…" : "Import"}
          </button>
          {progress && (
            <span className="muted" style={{ fontSize: 13 }}>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)
            </span>
          )}
        </div>

        {preview && (
          <div
            style={{
              background: "var(--cream-2, #fbf7ee)",
              border: "1px solid #e3ddcf",
              borderRadius: 10,
              padding: "12px 16px",
              fontSize: 13.5,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Dry-run preview</div>
            <Stat label="Valid domains" value={preview.parsed} />
            {preview.invalid > 0 && <Stat label="Skipped (unparseable)" value={preview.invalid} />}
            <Stat label="Already present" value={preview.existing} />
            <Stat label="Net-new" value={preview.fresh} accent />
            <Stat label={`Currently tagged "${source.trim()}"`} value={preview.sourceTotal} />
            {mode === "replace" && (
              <Stat label="Would be removed (replace)" value={preview.removed} warn />
            )}
            <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
              Nothing has been written. Click Import to apply.
            </p>
          </div>
        )}

        {log.length > 0 && (
          <pre
            style={{
              background: "var(--cream-2, #fbf7ee)",
              border: "1px solid #e3ddcf",
              borderRadius: 10,
              padding: "12px 14px",
              fontSize: 13,
              whiteSpace: "pre-wrap",
              margin: 0,
            }}
          >
            {log.join("\n")}
          </pre>
        )}

        <ImportHistory rows={history} onRefresh={loadHistory} />
      </div>
    </main>
  );
}

function Stat({ label, value, accent, warn }: { label: string; value: number; accent?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 700, color: warn ? "var(--coral-deep, #c2502f)" : accent ? "var(--coral, #e08a6f)" : "var(--navy)" }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function ImportHistory({ rows, onRefresh }: { rows: HistoryRow[]; onRefresh: () => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
        <Label>Recent imports</Label>
        <button
          onClick={onRefresh}
          className="muted"
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12, textDecoration: "underline" }}
        >
          refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>No imports logged yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--navy-3)", borderBottom: "1px solid #e3ddcf" }}>
                <th style={{ padding: "5px 8px" }}>When</th>
                <th style={{ padding: "5px 8px" }}>Target</th>
                <th style={{ padding: "5px 8px" }}>Source</th>
                <th style={{ padding: "5px 8px" }}>Mode</th>
                <th style={{ padding: "5px 8px", textAlign: "right" }}>Parsed</th>
                <th style={{ padding: "5px 8px", textAlign: "right" }}>Upserted</th>
                <th style={{ padding: "5px 8px", textAlign: "right" }}>Removed</th>
                <th style={{ padding: "5px 8px" }}>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id || i} style={{ borderBottom: "1px solid #efe9dc" }}>
                  <td style={{ padding: "5px 8px", whiteSpace: "nowrap" }}>{fmtTime(r.created_at)}</td>
                  <td style={{ padding: "5px 8px" }}>{r.target}</td>
                  <td style={{ padding: "5px 8px" }}>{r.source}</td>
                  <td style={{ padding: "5px 8px" }}>{r.mode}{r.backfilled ? " +bf" : ""}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{(r.parsed ?? 0).toLocaleString()}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{(r.upserted ?? 0).toLocaleString()}</td>
                  <td style={{ padding: "5px 8px", textAlign: "right" }}>{(r.removed ?? 0).toLocaleString()}</td>
                  <td style={{ padding: "5px 8px" }}>{(r.user_email || "").split("@")[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--navy-3)", marginBottom: 6 }}>
      {children}
    </div>
  );
}

function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", border: "1.5px solid #d9d2c2", borderRadius: 999, overflow: "hidden" }}>
      {options.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: "7px 16px",
            border: "none",
            borderLeft: i ? "1px solid #e3ddcf" : "none",
            background: value === o.v ? "var(--coral, #e08a6f)" : "#fff",
            color: value === o.v ? "#fff" : "var(--navy)",
            fontSize: 13.5,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
