"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
  missingOwner: number;
};

type EnrichStatus = { netNew: number; eligible: number; enriched: number };
type EnrichedDomain = { domain: string; quality_score: number | null; category: string | null; enriched: boolean };

type HistoryRow = {
  id?: string;
  target?: string;
  source?: string;
  mode?: string;
  parsed?: number;
  upserted?: number;
  removed?: number;
  backfilled?: boolean;
  import_ts?: string | null;
  user_email?: string | null;
  created_at?: string;
};

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;
const PRICE_RE = /^\$?[\d,]+(\.\d+)?$/;
// Per-target upload chunk. Universe goes through the merge RPC over a ~6M-row
// table, which is slower per row, so use a smaller batch (the server still
// halves further on a statement-timeout). Master is a plain upsert.
const CHUNK = { universe: 400, master: 1000 } as const;
// Quality floor for the optional post-import LLM enrich (matches the >1 rollout
// band). Passed to enrich-batch --quality-min (>=).
const ENRICH_QUALITY_MIN = 1;

// Steps shown in the visual "How to use" explainer at the top of the page.
const HOWTO_STEPS: { t: string; d: React.ReactNode }[] = [
  { t: "Add the domains", d: <>Drop a CSV or paste. Columns: <b>domain</b> (required), <b>owner</b> (required), <b>price</b> (optional). Headers auto-ignored — or grab the template.</> },
  { t: "Name the source", d: <>Type to pick an existing source or create a new one. This tag groups the names and scopes net-new + enrich.</> },
  { t: "Merge or Replace", d: <><b>Merge</b> appends &amp; keeps history; <b>Replace</b> wipes this source&rsquo;s rows first, then imports.</> },
  { t: "Backfill & enrich", d: <>Optional. Backfill = free scores. Enrich = paid LLM, only on <b>net-new</b> names with quality ≥ {ENRICH_QUALITY_MIN}.</> },
  { t: "Preview, then Start", d: <><b>Preview</b> = dry-run (new vs. existing counts, no writes). <b>Start</b> applies it; big files chunk automatically.</> },
];

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
  canReplace,
}: {
  universeReady: boolean;
  masterReady: boolean;
  canReplace: boolean;
}) {
  // Master-only tool: admin.imports alone covers it; there's no corpus picker
  // (the universe code path stays server-side, but the UI never targets it, so
  // target is fixed to "master" — no setter exposed).
  const [target] = useState<Target>("master");
  const [source, setSource] = useState("");
  const [mode, setMode] = useState<Mode>("merge");
  // Replace is a destructive, permission-gated mode. Without it, imports always
  // Merge and the Mode toggle is hidden — clamp any stray replace selection.
  useEffect(() => {
    if (!canReplace && mode !== "merge") setMode("merge");
  }, [canReplace, mode]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [autoBackfill, setAutoBackfill] = useState(true);
  const [autoEnrich, setAutoEnrich] = useState(true);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [sourcesUniverse, setSourcesUniverse] = useState<string[]>([]);
  const [sourcesMaster, setSourcesMaster] = useState<string[]>([]);
  const [inputMode, setInputMode] = useState<"file" | "paste">("file");
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Suggestions for the active target only — Universe shows pipeline/registry
  // names, Master shows its own curated owner-sheet sources.
  const knownSources = target === "universe" ? sourcesUniverse : sourcesMaster;

  const add = (line: string) => setLog((l) => [...l, line]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/imports", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(data.history)) setHistory(data.history as HistoryRow[]);
      if (res.ok && Array.isArray(data.sourcesUniverse)) setSourcesUniverse(data.sourcesUniverse as string[]);
      if (res.ok && Array.isArray(data.sourcesMaster)) setSourcesMaster(data.sourcesMaster as string[]);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  async function loadFile(f: File) {
    setText(await f.text());
    setFileName(f.name);
    setPreview(null);
    add(`Loaded file: ${f.name} (${(f.size / 1024).toFixed(0)} KB)`);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) await loadFile(f);
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) await loadFile(f);
  }

  function downloadTemplate() {
    const header = target === "master" ? "domain,owner,price" : "domain,price";
    const sample = target === "master"
      ? ["example.com,Digimedia,2500", "brand.io,Acme Holdings,"]
      : ["example.com,2500", "brand.io,"];
    const blob = new Blob([`${header}\n${sample.join("\n")}\n`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-template-${target}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
      // Stream domain strings in batches so we never POST the whole file (413).
      const domains = rows.map((r) => r.domain);
      const parsed = domains.length;
      const PCHUNK = 3000;
      let existing = 0;
      for (let i = 0; i < domains.length; i += PCHUNK) {
        const data = await post({ action: "preview-existing", target, domains: domains.slice(i, i + PCHUNK) });
        existing += Number(data.count || 0);
      }
      const st = await post({ action: "preview-source-total", target, source: src });
      const sourceTotal = Number(st.count || 0);
      const fresh = parsed - existing;
      const removed = mode === "replace" ? Math.max(0, sourceTotal - existing) : 0;
      const missingOwner = target === "master"
        ? rows.filter((r) => !r.owner || !String(r.owner).trim()).length
        : 0;
      setPreview({ parsed, invalid: 0, existing, fresh, removed, sourceTotal, missingOwner });
      if (missingOwner > 0) {
        add(`⚠️ ${missingOwner.toLocaleString()} of ${parsed.toLocaleString()} row(s) have no owner — owner is required; the import will be blocked until every domain has one.`);
      }
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

    // Owner is required on Master — every domain must carry an owner.
    if (target === "master") {
      const missing = rows.filter((r) => !r.owner || !String(r.owner).trim()).length;
      if (missing) {
        add(`⚠️ Owner is required — ${missing.toLocaleString()} of ${rows.length.toLocaleString()} row(s) have no owner. Add an owner for every domain and re-upload.`);
        return;
      }
    }

    // Replace mode deletes rows — double opt-in: the checkbox AND a confirm
    // dialog that spells out the consequence (with the previewed delete count).
    if (mode === "replace") {
      if (!confirmReplace) {
        add("⚠️ Replace mode deletes rows. Tick the confirmation box to proceed.");
        return;
      }
      const willRemove = preview && preview.removed > 0
        ? `up to ${preview.removed.toLocaleString()} existing "${src}" row(s) not in this file`
        : `existing "${src}" row(s) not present in this file`;
      const ok = window.confirm(
        `REPLACE "${src}" in ${target}.\n\nThis upserts the file, then DELETES ${willRemove}. ` +
        `This cannot be undone.\n\nProceed?`,
      );
      if (!ok) { add("Replace cancelled."); return; }
    }

    setBusy(true);
    setLog([]);
    const importTs = new Date().toISOString();
    const today = importTs.slice(0, 10);
    add(`Parsed ${rows.length.toLocaleString()} domains → ${target} (source "${src}", ${mode}).`);
    setProgress({ done: 0, total: rows.length });
    let upserted = 0;
    let removed = 0;
    const chunkSize = CHUNK[target];
    try {
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const data = await post({ action: "upsert", target, source: src, rows: chunk, importTs, today });
        upserted += data.upserted || 0;
        setProgress({ done: Math.min(i + chunkSize, rows.length), total: rows.length });
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
          await post({
            action: "post-backfill", target, source: src,
            enrich: autoEnrich, qualityMin: ENRICH_QUALITY_MIN, newSince: importTs,
          });
          backfilled = true;
          add(target === "universe"
            ? "🔧 Dispatched structural + quality backfill for new universe rows."
            : "🔧 Dispatched quality-score backfill for new Master rows.");
          if (autoEnrich) {
            add(`🧠 Will auto-enrich new names with quality_score > ${ENRICH_QUALITY_MIN} after backfill (runs immediately unless big enough to batch).`);
          }
        } catch (e) {
          add(`⚠️ Backfill dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        add(target === "universe"
          ? "Done. Run “Backfill universe structural fields” to fill word/dictionary fields on new rows."
          : "Done.");
      }

      // Record the run in the import-history log (best-effort).
      await post({ action: "log", target, source: src, mode, parsed: rows.length, upserted, removed, backfilled, importTs }).catch(() => {});
      loadHistory();
    } catch (e) {
      add(`❌ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function deleteJob(id?: string) {
    if (!id) return;
    setHistory((h) => h.filter((r) => r.id !== id)); // optimistic
    try {
      await post({ action: "delete-log", id });
    } catch {
      loadHistory(); // restore on failure
    }
  }

  // Re-dispatch the (idempotent) backfill + quality-banded enrich for a past
  // import's source — the self-serve fix for an enrich that failed or was
  // skipped at import time. Returns a status string for the card to show.
  async function reenrich(r: HistoryRow): Promise<"ok" | "error"> {
    const tgt: Target = r.target === "master" ? "master" : "universe";
    if (!r.source) return "error";
    try {
      await post({ action: "post-backfill", target: tgt, source: r.source, enrich: true, retryFailed: true, qualityMin: ENRICH_QUALITY_MIN, newSince: r.import_ts || r.created_at });
      return "ok";
    } catch {
      return "error";
    }
  }

  // Live enrichment progress for a past import's source (eligible q>=floor +
  // how many are enriched). Null on error so the card can degrade gracefully.
  async function fetchStatus(r: HistoryRow): Promise<EnrichStatus | null> {
    const tgt: Target = r.target === "master" ? "master" : "universe";
    if (!r.source) return null;
    try {
      const data = await post({ action: "enrich-status", target: tgt, source: r.source, qualityMin: ENRICH_QUALITY_MIN, newSince: r.import_ts || r.created_at });
      return data.status as EnrichStatus;
    } catch {
      return null;
    }
  }

  // The actual net-new qualifying domains for a past import + their enrich state.
  async function fetchEnrichedList(r: HistoryRow): Promise<EnrichedDomain[] | null> {
    const tgt: Target = r.target === "master" ? "master" : "universe";
    if (!r.source) return null;
    try {
      const data = await post({ action: "enriched-list", target: tgt, source: r.source, qualityMin: ENRICH_QUALITY_MIN, newSince: r.import_ts || r.created_at });
      return data.domains as EnrichedDomain[];
    } catch {
      return null;
    }
  }

  const targetReady = target === "universe" ? universeReady : masterReady;
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const hasInput = parseRows(text).length > 0;

  return (
    <main>
      <section className="card" style={{ padding: "20px 24px", marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
          <h2 style={{ margin: 0, fontSize: "1.2rem" }}>How to use this tool</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            Bulk-import domains into a corpus, tag them with a source, then optionally score &amp; enrich the new ones.
          </span>
        </div>

        <div style={{ fontSize: 13.5, color: "var(--navy-2)", marginBottom: 18, padding: "10px 14px", border: "1px solid var(--coral)", borderRadius: 10, background: "rgba(228,128,105,.07)" }}>
          👤 Domains import to the <b>Master Domain List</b> — CSVs with the <code>owner</code> you know.
        </div>

        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--navy-3)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 10 }}>
          Then — the steps
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(255px, 1fr))", rowGap: 14, columnGap: 22 }}>
          {(canReplace ? HOWTO_STEPS : HOWTO_STEPS.filter((s) => s.t !== "Merge or Replace")).map((s, i) => (
            <div key={i} style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
              <span style={{ flex: "0 0 auto", width: 24, height: 24, borderRadius: "50%", background: "var(--coral-deep, #cf6849)", color: "#fff", fontSize: 13, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{i + 1}</span>
              <div>
                <div style={{ fontWeight: 700, color: "var(--navy)", fontSize: 14 }}>{s.t}</div>
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5, marginTop: 2 }}>{s.d}</div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line, #eee)" }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--navy-3)", textTransform: "uppercase", letterSpacing: ".05em", marginBottom: 9 }}>
            After it runs — the Past Imports funnel
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {["Inserted", "Net-new", `Quality q≥${ENRICH_QUALITY_MIN}`, "Enriched X / Y"].map((c, i, arr) => (
              <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                <span style={{ border: "1px solid var(--line, #e3ddcf)", borderRadius: 999, padding: "4px 13px", fontSize: 12.5, fontWeight: 600, color: "var(--navy-2)", background: "var(--cream-2, #fbf7ec)" }}>{c}</span>
                {i < arr.length - 1 && <span style={{ color: "var(--navy-3)", fontWeight: 700 }}>→</span>}
              </span>
            ))}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
            Status dot <span style={{ color: "#3a9b6e", fontWeight: 700 }}>● done</span> · <span style={{ color: "#c79a1e", fontWeight: 700 }}>● running</span> · <span style={{ color: "var(--coral-deep)", fontWeight: 700 }}>● stalled</span>. <b>Re-enrich</b> re-runs the LLM pass; the trash icon removes only the history entry, not the domains.
          </div>
        </div>
      </section>
      <section className="card" style={{ padding: "26px 28px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: "1.7rem" }}>Upload Domains</h2>
          <button className="btn btn--ghost" onClick={downloadTemplate} style={{ padding: "9px 16px", fontSize: 14 }}>
            ↓ Download Template
          </button>
        </div>
        <p className="muted" style={{ marginTop: 6, marginBottom: 2, fontSize: 14.5 }}>
          {target === "master"
            ? <>Upload a CSV or paste. Columns: <b>domain</b> (required), <b>owner</b> (required), <b>price</b> (optional). Headers are auto-detected and ignored.</>
            : <>Upload a CSV or paste. Columns: <b>domain</b> (required), <b>price</b> (optional). Headers are auto-detected and ignored.</>}
        </p>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {target === "universe"
            ? "Owner isn’t stored on Universe — it’s derived from the source feed. Import CSVs with known owners to Master instead."
            : "Date added / first-seen are set automatically — no need to include them."}
        </p>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Sent in chunks of {CHUNK[target].toLocaleString()}; structural + quality scores are computed after upload.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 18 }}>
          {/* Master-only — no corpus picker (admin.imports covers it). */}
          {!targetReady && (
            <p style={{ color: "var(--coral-deep)", fontSize: 13 }}>
              Not configured — add MASTERLIST_SUPABASE_* env vars.
            </p>
          )}

          {/* DROPZONE / PASTE */}
          <div>
            <FieldLabel>Domains{target === "master" ? " (+ price, owner)" : " (+ price)"}</FieldLabel>
            {inputMode === "file" ? (
              <>
                <div
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    border: `2px dashed ${dragOver ? "var(--coral)" : "var(--line, #d9d2c2)"}`,
                    background: dragOver ? "rgba(228,128,105,.06)" : "var(--cream-2, #fbf7ec)",
                    borderRadius: "var(--radius, 20px)",
                    padding: "44px 18px",
                    textAlign: "center",
                    cursor: "pointer",
                    transition: "border-color .12s, background .12s",
                  }}
                >
                  <UploadIcon />
                  <div style={{ fontSize: 18, fontWeight: 600, color: "var(--navy)", marginTop: 10 }}>
                    {fileName ? `📄 ${fileName}` : "Drag and drop your CSV file here"}
                  </div>
                  <div className="muted" style={{ fontSize: 14, margin: "6px 0 14px" }}>or</div>
                  <span className="btn btn--ghost" style={{ padding: "10px 20px", fontSize: 14 }}>Browse Files</span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt,text/csv,text/plain"
                  onChange={onFile}
                  style={{ display: "none" }}
                />
                <div style={{ marginTop: 8 }}>
                  <LinkBtn onClick={() => setInputMode("paste")}>or paste domains instead</LinkBtn>
                </div>
              </>
            ) : (
              <>
                <textarea
                  className="field"
                  rows={8}
                  placeholder={target === "master"
                    ? "example.com, 99999, digimedia\nbobby.com, 1995, Acme Holdings\n…"
                    : "example.com, 99999\nbobby.com, 1995\n…"}
                  value={text}
                  onChange={(e) => { setText(e.target.value); setFileName(null); setPreview(null); }}
                  style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
                />
                <div style={{ marginTop: 4 }}>
                  <LinkBtn onClick={() => setInputMode("file")}>or upload a file instead</LinkBtn>
                </div>
              </>
            )}
            {hasInput && (
              <p className="muted" style={{ fontSize: 12.5, marginTop: 6, marginBottom: 0 }}>
                {parseRows(text).length.toLocaleString()} valid domain(s) detected.
              </p>
            )}
          </div>

          {/* SOURCE */}
          <div>
            <FieldLabel>Domain source</FieldLabel>
            <div style={{ position: "relative", maxWidth: 420 }}>
              <input
                className="field"
                placeholder="Select or type a source…"
                value={source}
                list="import-source-names"
                autoComplete="off"
                onChange={(e) => { setSource(e.target.value); setPreview(null); }}
                style={{ width: "100%", paddingRight: 30 }}
              />
              <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "var(--navy-3)", pointerEvents: "none" }}>▾</span>
              <datalist id="import-source-names">
                {knownSources.map((s) => <option key={s} value={s} />)}
              </datalist>
            </div>
            <SourceHint source={source} known={knownSources} onPick={(s) => { setSource(s); setPreview(null); }} />
          </div>

          {/* MODE — Replace is destructive + permission-gated; hidden otherwise (always Merge). */}
          {canReplace && (
          <div>
            <FieldLabel>Mode</FieldLabel>
            <Seg
              value={mode}
              onChange={(v) => { setMode(v as Mode); setConfirmReplace(false); setPreview(null); }}
              options={[
                { v: "merge", label: "Merge (add / update)" },
                { v: "replace", label: "Replace this source" },
              ]}
            />
            {mode === "replace" && (
              <div
                style={{
                  marginTop: 10,
                  background: "rgba(228,128,105,.08)",
                  border: "2px solid var(--coral)",
                  borderRadius: "var(--radius-sm, 14px)",
                  padding: "12px 16px",
                }}
              >
                <p style={{ fontSize: 13, margin: "0 0 8px", color: "var(--coral-deep)", fontWeight: 600 }}>
                  ⚠️ Replace upserts the file, then <b>deletes</b> rows of this source not in it. Use only
                  for full snapshots. This cannot be undone.
                </p>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, cursor: "pointer", fontWeight: 600 }}>
                  <input type="checkbox" checked={confirmReplace} onChange={(e) => setConfirmReplace(e.target.checked)} />
                  I understand this deletes rows not present in the file.
                </label>
              </div>
            )}
          </div>
          )}

          {/* OPTIONS */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={autoBackfill}
                onChange={(e) => { setAutoBackfill(e.target.checked); if (!e.target.checked) setAutoEnrich(false); }}
              />
              Auto-run {target === "universe" ? "structural + quality" : "quality-score"} backfill after import
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, cursor: autoBackfill ? "pointer" : "not-allowed", opacity: autoBackfill ? 1 : 0.5, marginLeft: 22 }}>
              <input type="checkbox" checked={autoEnrich} disabled={!autoBackfill} onChange={(e) => setAutoEnrich(e.target.checked)} />
              Then LLM-enrich new names with quality_score &gt; {ENRICH_QUALITY_MIN} <span className="muted">(paid)</span>
            </label>
            {autoEnrich && (
              <p className="muted" style={{ fontSize: 12, margin: "0 0 0 22px", lineHeight: 1.4 }}>
                After scores are computed, enriches names above the floor from this source that aren&apos;t
                enriched yet — <b>immediately</b> for smaller imports, or via the cheaper async Batches API
                (collected within ~4h) when it&apos;s big enough to save $5+.
              </p>
            )}
          </div>

          {/* ACTIONS */}
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <button className="btn btn--ghost" onClick={onPreview} disabled={busy || previewing || !targetReady} style={{ flex: "0 0 auto" }}>
              {previewing ? "Previewing…" : "Preview"}
            </button>
            <button
              className="btn btn--primary"
              onClick={run}
              disabled={busy || !targetReady || (mode === "replace" && !confirmReplace)}
              style={{ flex: 1, color: "#fff", borderColor: "var(--coral)", boxShadow: "none" }}
            >
              {busy
                ? (progress ? `Importing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()} (${pct}%)` : "Importing…")
                : mode === "replace" ? "Start Replace Import" : "Start Import"}
            </button>
          </div>

          {preview && (
            <div className="card card--flat" style={{ padding: "14px 18px", fontSize: 13.5 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Dry-run preview</div>
              <Stat label="Valid domains" value={preview.parsed} />
              {preview.invalid > 0 && <Stat label="Skipped (unparseable)" value={preview.invalid} />}
              {preview.missingOwner > 0 && <Stat label="Missing owner (required)" value={preview.missingOwner} warn />}
              <Stat label="Already present" value={preview.existing} />
              <Stat label="Net-new" value={preview.fresh} accent />
              <Stat label={`Currently tagged "${source.trim()}"`} value={preview.sourceTotal} />
              {mode === "replace" && <Stat label="Would be removed (replace)" value={preview.removed} warn />}
              <p className="muted" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
                Nothing has been written. Click Start Import to apply.
              </p>
            </div>
          )}

          {log.length > 0 && (
            <pre className="card card--flat" style={{ padding: "12px 14px", fontSize: 13, whiteSpace: "pre-wrap", margin: 0 }}>
              {log.join("\n")}
            </pre>
          )}
        </div>
      </section>

      <PastJobs rows={history} onRefresh={loadHistory} onDelete={deleteJob} onReenrich={reenrich} onStatus={fetchStatus} onList={fetchEnrichedList} />
    </main>
  );
}

/* ---------- subcomponents ---------- */

function UploadIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--navy-3)" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" style={{ display: "inline-block" }}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6" />
    </svg>
  );
}

function SourceHint({ source, known, onPick }: { source: string; known: string[]; onPick: (s: string) => void }) {
  const q = source.trim().toLowerCase();
  if (!q) return null;
  if (known.some((s) => s.toLowerCase() === q)) {
    return <span className="muted" style={{ fontSize: 12, display: "inline-block", marginTop: 6 }}>↳ matches an existing source ✓</span>;
  }
  const near = known.filter((s) => s.toLowerCase().includes(q)).slice(0, 5);
  if (near.length) {
    return (
      <div style={{ fontSize: 12, marginTop: 6 }}>
        <span className="muted">existing: </span>
        {near.map((s) => (
          <button key={s} onClick={() => onPick(s)}
            style={{ border: "none", background: "none", color: "var(--coral)", cursor: "pointer", padding: 0, marginRight: 10, textDecoration: "underline" }}>
            {s}
          </button>
        ))}
      </div>
    );
  }
  return <span className="muted" style={{ fontSize: 12, display: "inline-block", marginTop: 6 }}>new source — will be created</span>;
}

function Stat({ label, value, accent, warn }: { label: string; value: number; accent?: boolean; warn?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 700, color: warn ? "var(--coral-deep)" : accent ? "var(--coral)" : "var(--navy)" }}>
        {value.toLocaleString()}
      </span>
    </div>
  );
}

function PastJobs({
  rows, onRefresh, onDelete, onReenrich, onStatus, onList,
}: {
  rows: HistoryRow[]; onRefresh: () => void; onDelete: (id?: string) => void;
  onReenrich: (r: HistoryRow) => Promise<"ok" | "error">;
  onStatus: (r: HistoryRow) => Promise<EnrichStatus | null>;
  onList: (r: HistoryRow) => Promise<EnrichedDomain[] | null>;
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: "1.4rem" }}>Past Imports</h2>
        <button onClick={onRefresh} className="muted"
          style={{ border: "none", background: "none", cursor: "pointer", fontSize: 12.5, textDecoration: "underline" }}>
          refresh
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>Last {rows.length || 0} import runs</p>

      {rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 13.5 }}>No imports logged yet.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((r, i) => <JobCard key={r.id || i} r={r} onDelete={onDelete} onReenrich={onReenrich} onStatus={onStatus} onList={onList} />)}
        </div>
      )}
    </section>
  );
}

function JobCard({
  r, onDelete, onReenrich, onStatus, onList,
}: {
  r: HistoryRow; onDelete: (id?: string) => void;
  onReenrich: (r: HistoryRow) => Promise<"ok" | "error">;
  onStatus: (r: HistoryRow) => Promise<EnrichStatus | null>;
  onList: (r: HistoryRow) => Promise<EnrichedDomain[] | null>;
}) {
  const [state, setState] = useState<"idle" | "busy" | "ok" | "error">("idle");
  const [status, setStatus] = useState<EnrichStatus | null | "loading">("loading");
  const [listOpen, setListOpen] = useState(false);
  const [list, setList] = useState<EnrichedDomain[] | null | "loading">(null);
  const counts = [
    `${(r.upserted ?? 0).toLocaleString()} inserted`,
    (r.removed ?? 0) > 0 ? `${(r.removed ?? 0).toLocaleString()} removed` : null,
  ].filter(Boolean).join(" · ");
  const dbLabel = r.target === "master" ? "Master Domain List" : "name_universe";

  const loadStatus = useCallback(() => {
    setStatus("loading");
    onStatus(r).then((s) => setStatus(s));
  }, [onStatus, r]);
  useEffect(() => { loadStatus(); }, [loadStatus]);

  async function reenrich() {
    const ok = window.confirm(
      `Re-enrich "${r.source}" in ${r.target}?\n\nRe-runs the quality backfill (idempotent), then runs a PAID LLM enrich ` +
      `(quality_score > 1) for names from this source that aren’t enriched yet — immediately, or via the cheaper async batch if it’s large.`,
    );
    if (!ok) return;
    setState("busy");
    const res = await onReenrich(r);
    setState(res);
    if (res === "ok") setTimeout(loadStatus, 1500);
  }

  function toggleList() {
    const next = !listOpen;
    setListOpen(next);
    if (next && list === null) {
      setList("loading");
      onList(r).then((d) => setList(d));
    }
  }

  // Age in hours, to distinguish "still processing" from "should be done by now".
  const ageH = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 3.6e6 : 0;
  const hasEligible = status && status !== "loading" && status.eligible > 0;

  return (
    <div className="card card--flat" style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--navy)" }}>
          {r.source || "—"} <span className="muted" style={{ fontWeight: 400, fontSize: 13.5 }}>→ {dbLabel}</span>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
          <span>{r.mode === "replace" ? "Replace" : "Merge"}</span>
          <span>·</span>
          <span>{counts}</span>
          <span>·</span>
          <span>{fmtTime(r.created_at)}</span>
          {r.user_email && <><span>·</span><span>{r.user_email.split("@")[0]}</span></>}
        </div>
        <EnrichLine status={status} ageH={ageH} backfilled={Boolean(r.backfilled)} inserted={r.upserted ?? 0} />
        {hasEligible && (
          <LinkBtn onClick={toggleList}>
            {listOpen ? "▾ hide domains" : `▸ view the ${(status as EnrichStatus).eligible.toLocaleString()} qualifying domains`}
          </LinkBtn>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        {state === "ok" ? (
          <span style={{ fontSize: 12.5, color: "var(--navy-2)" }}>enrich dispatched ✓</span>
        ) : state === "error" ? (
          <span style={{ fontSize: 12.5, color: "var(--coral-deep)" }}>failed — retry</span>
        ) : null}
        <button
          onClick={reenrich}
          disabled={state === "busy" || !r.source}
          title="Re-run the quality backfill + enrich for this source"
          className="btn btn--ghost"
          style={{ padding: "6px 13px", fontSize: 12.5, boxShadow: "0 2px 0 rgba(37,66,84,.18)" }}
        >
          {state === "busy" ? "Dispatching…" : "Re-enrich"}
        </button>
        <button
          onClick={() => onDelete(r.id)}
          title="Remove from history"
          aria-label="Remove from history"
          style={{ border: "none", background: "none", cursor: "pointer", color: "var(--navy-3)", padding: 4 }}
        >
          <TrashIcon />
        </button>
      </div>
      </div>
      {listOpen && <DomainList list={list} />}
    </div>
  );
}

function DomainList({ list }: { list: EnrichedDomain[] | null | "loading" }) {
  if (list === "loading") return <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>loading domains…</div>;
  if (list === null) return <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>couldn’t load domains.</div>;
  if (!list.length) return <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>no qualifying domains.</div>;
  return (
    <div style={{ marginTop: 12, border: "1px solid var(--line, #e3ddcf)", borderRadius: 10, overflow: "hidden" }}>
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--navy-3)", background: "var(--cream-2, #fbf7ec)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 12px" }}>Domain</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Quality</th>
              <th style={{ padding: "6px 12px" }}>Category</th>
              <th style={{ padding: "6px 12px" }}>Enriched</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.domain} style={{ borderTop: "1px solid var(--line, #f1ece0)" }}>
                <td style={{ padding: "6px 12px", fontFamily: "monospace", color: "var(--navy)" }}>{d.domain}</td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "var(--navy-2)" }}>
                  {d.quality_score != null ? d.quality_score.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "6px 12px", color: "var(--navy-2)" }}>{d.category || "—"}</td>
                <td style={{ padding: "6px 12px" }}>
                  {d.enriched
                    ? <span style={{ color: "#1f9d55", fontWeight: 700 }}>✓</span>
                    : <span style={{ color: "#b8860b" }}>⏳</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EnrichLine({
  status, ageH, inserted,
}: {
  status: EnrichStatus | null | "loading"; ageH: number; backfilled: boolean; inserted: number;
}) {
  if (status === "loading") {
    return <div style={{ fontSize: 13, marginTop: 12, color: "var(--navy-3)" }}>checking enrichment…</div>;
  }
  if (status === null) {
    return (
      <div style={{ display: "flex", gap: 26, marginTop: 12, flexWrap: "wrap" }}>
        <StatBlock label="Inserted" value={inserted.toLocaleString()} />
        <StatBlock label="Status" value="unavailable" muted />
      </div>
    );
  }
  const { netNew, eligible, enriched } = status;
  const done = eligible > 0 && enriched >= eligible;
  const stalled = eligible > 0 && enriched === 0 && ageH >= 24;
  const color = eligible === 0 ? "var(--navy-3)" : done ? "#1f9d55" : stalled ? "var(--coral-deep)" : "#b8860b";
  const icon = eligible === 0 ? "" : done ? "✓" : stalled ? "✗" : "⏳";
  return (
    <div style={{ display: "flex", gap: 26, marginTop: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
      <StatBlock label="Inserted" value={inserted.toLocaleString()} />
      <StatBlock label="Net-new" value={netNew.toLocaleString()} />
      <StatBlock label="Quality q≥1" value={eligible.toLocaleString()} />
      <StatBlock
        label="Enriched"
        value={`${enriched.toLocaleString()}/${eligible.toLocaleString()}`}
        color={color}
        icon={icon}
      />
    </div>
  );
}

function StatBlock({ label, value, color, icon, muted }: {
  label: string; value: string; color?: string; icon?: string; muted?: boolean;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--navy-3)" }}>
        {label}
      </span>
      <span style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.05, color: color || (muted ? "var(--navy-3)" : "var(--navy)"), display: "flex", alignItems: "center", gap: 6 }}>
        {icon ? <span aria-hidden style={{ fontSize: 16 }}>{icon}</span> : null}
        {value}
      </span>
    </div>
  );
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days >= 1) return `${days} day${days > 1 ? "s" : ""} ago`;
  const hrs = Math.floor(diff / 3_600_000);
  if (hrs >= 1) return `${hrs}h ago`;
  const mins = Math.floor(diff / 60_000);
  return mins >= 1 ? `${mins}m ago` : "just now";
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--navy-3)", marginBottom: 7 }}>
      {children}
    </div>
  );
}

function LinkBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="muted"
      style={{ border: "none", background: "none", cursor: "pointer", fontSize: 13, textDecoration: "underline" }}>
      {children}
    </button>
  );
}

function Seg({
  value, onChange, options,
}: {
  value: string; onChange: (v: string) => void; options: { v: string; label: string }[];
}) {
  return (
    <div style={{ display: "inline-flex", border: "2px solid var(--line, #d9d2c2)", borderRadius: 999, overflow: "hidden" }}>
      {options.map((o, i) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: "8px 18px",
            border: "none",
            borderLeft: i ? "1px solid var(--line, #e3ddcf)" : "none",
            background: value === o.v ? "var(--coral)" : "#fff",
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
