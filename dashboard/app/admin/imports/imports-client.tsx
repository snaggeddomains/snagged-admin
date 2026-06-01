"use client";

import { useState } from "react";

type Target = "universe" | "master";
type Mode = "merge" | "replace";
type Row = { domain: string; price: number | null };

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const CHUNK = 1000;

// Parse pasted text OR a CSV file: one row per line, find the cell that looks
// like a domain + an optional numeric price cell. Header/junk lines (no domain)
// are skipped, so it tolerates "name,listed price,date added" headers etc.
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
    const priceCell = cells.find((c) => c !== domain && /^\$?[\d,]+(\.\d+)?$/.test(c));
    const price = priceCell ? Number(priceCell.replace(/[^0-9.]/g, "")) : null;
    out.push({ domain: d, price: price != null && isFinite(price) ? price : null });
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

  const add = (line: string) => setLog((l) => [...l, line]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setText(await f.text());
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
    try {
      let upserted = 0;
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
        add(`🗑️ Removed ${Number(data.removed || 0).toLocaleString()} stale rows.`);
      }
      add(target === "universe"
        ? "Done. Run “Backfill universe structural fields” to fill word/dictionary fields on new rows."
        : "Done.");
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
            onChange={(v) => setTarget(v as Target)}
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
            onChange={(e) => setSource(e.target.value)}
            style={{ maxWidth: 320 }}
          />
        </div>

        <div>
          <Label>Mode</Label>
          <Seg
            value={mode}
            onChange={(v) => setMode(v as Mode)}
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
            onChange={(e) => setText(e.target.value)}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
          />
          <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={onFile} style={{ marginTop: 8 }} />
          <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
            One per line. A domain cell + optional price are auto-detected; headers are ignored.
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <button className="btn btn--navy" onClick={run} disabled={busy || !targetReady}>
            {busy ? "Importing…" : "Import"}
          </button>
          {progress && (
            <span className="muted" style={{ fontSize: 13 }}>
              {progress.done.toLocaleString()} / {progress.total.toLocaleString()} ({pct}%)
            </span>
          )}
        </div>

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
      </div>
    </main>
  );
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
