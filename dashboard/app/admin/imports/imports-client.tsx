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
// Quality floor for the optional post-import LLM enrich (matches the >1 rollout
// band). Passed to enrich-batch --quality-min (>=).
const ENRICH_QUALITY_MIN = 1;

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
  const [autoEnrich, setAutoEnrich] = useState(false);
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
    const header = target === "master" ? "domain,price,owner" : "domain,price";
    const sample = target === "master"
      ? ["example.com,2500,Digimedia", "brand.io,,Acme Holdings"]
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
          await post({
            action: "post-backfill", target, source: src,
            enrich: autoEnrich, qualityMin: ENRICH_QUALITY_MIN,
          });
          backfilled = true;
          add(target === "universe"
            ? "🔧 Dispatched structural + quality backfill for new universe rows."
            : "🔧 Dispatched quality-score backfill for new Master rows.");
          if (autoEnrich) {
            add(`🧠 Will auto-enrich new names with quality_score > ${ENRICH_QUALITY_MIN} after backfill (Batches API; collected by the 4h cron).`);
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
      await post({ action: "log", target, source: src, mode, parsed: rows.length, upserted, removed, backfilled }).catch(() => {});
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

  const targetReady = target === "universe" ? universeReady : masterReady;
  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const hasInput = parseRows(text).length > 0;

  return (
    <main style={{ maxWidth: 940, margin: "0 auto" }}>
      <section className="card" style={{ padding: "26px 28px" }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <h2 style={{ margin: 0, fontSize: "1.7rem" }}>Upload Domains</h2>
          <button className="btn btn--ghost" onClick={downloadTemplate} style={{ padding: "9px 16px", fontSize: 14 }}>
            ↓ Download Template
          </button>
        </div>
        <p className="muted" style={{ marginTop: 6, marginBottom: 2, fontSize: 14.5 }}>
          Upload a CSV or paste domains. Columns: <b>domain</b> (required), price
          {target === "master" ? ", owner" : ""} (optional). Headers are auto-detected and ignored.
        </p>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          {target === "universe"
            ? "Owner isn’t stored on Universe — it’s derived from the source feed. Import CSVs with known owners to Master instead."
            : "Date added / first-seen are set automatically — no need to include them."}
        </p>
        <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
          Sent in chunks of {CHUNK.toLocaleString()}; structural + quality scores are computed after upload.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 18 }}>
          {/* WHERE */}
          <div>
            <FieldLabel>Where does this belong?</FieldLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <TargetCard
                active={target === "universe"}
                onClick={() => { setTarget("universe"); setConfirmReplace(false); setPreview(null); }}
                title="Universe"
                subtitle="name_universe"
                blurb="Automated marketplace scrapes & platform dumps — afternic, Sedo, Atom, Namecheap, BrandBucket. sources[] array."
                examples="sedo_dump · afternic · atom_daily · brandbucket"
              />
              <TargetCard
                active={target === "master"}
                onClick={() => { setTarget("master"); setConfirmReplace(false); setPreview(null); }}
                title="Master List"
                subtitle="Master Domain List"
                blurb="Manual / curated owner attributions — one-off CSVs & portfolio sheets where you know the owner."
                examples="Digimedia · portfolio sheets · owner exports"
              />
            </div>
            {!targetReady && (
              <p style={{ color: "var(--coral-deep)", fontSize: 13, marginTop: 8 }}>
                Not configured — add {target === "universe" ? "SUPABASE_NAMING_*" : "MASTERLIST_SUPABASE_*"} env vars.
              </p>
            )}
          </div>

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
                  placeholder={"example.com\nbobby.com, 1995\n…"}
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

          {/* MODE */}
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
              Then LLM-enrich new names with quality_score &gt; {ENRICH_QUALITY_MIN} <span className="muted">(paid · Batches API)</span>
            </label>
            {autoEnrich && (
              <p className="muted" style={{ fontSize: 12, margin: "0 0 0 22px", lineHeight: 1.4 }}>
                After scores are computed, submits an enrich batch scoped to this source for names above the
                floor that aren&apos;t enriched yet. Picked up by the existing 4-hour auto-collect.
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
              style={{ flex: 1, color: "#fff" }}
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

      <PastJobs rows={history} onRefresh={loadHistory} onDelete={deleteJob} />
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

function PastJobs({ rows, onRefresh, onDelete }: { rows: HistoryRow[]; onRefresh: () => void; onDelete: (id?: string) => void }) {
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
          {rows.map((r, i) => <JobCard key={r.id || i} r={r} onDelete={onDelete} />)}
        </div>
      )}
    </section>
  );
}

function JobCard({ r, onDelete }: { r: HistoryRow; onDelete: (id?: string) => void }) {
  const counts = [
    `${(r.upserted ?? 0).toLocaleString()} upserted`,
    (r.removed ?? 0) > 0 ? `${(r.removed ?? 0).toLocaleString()} removed` : null,
    `${(r.parsed ?? 0).toLocaleString()} parsed`,
  ].filter(Boolean).join(" · ");
  const dbLabel = r.target === "master" ? "Master Domain List" : "name_universe";
  return (
    <div className="card card--flat" style={{ padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: "var(--navy)" }}>
          {r.source || "—"} <span className="muted" style={{ fontWeight: 400, fontSize: 13.5 }}>→ {dbLabel}</span>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 4, display: "flex", flexWrap: "wrap", gap: "0 10px" }}>
          <span>{r.mode === "replace" ? "Replace" : "Merge"}</span>
          <span>·</span>
          <span>{counts}</span>
          {r.backfilled && <><span>·</span><span style={{ color: "var(--navy-2)" }}>backfill dispatched</span></>}
          <span>·</span>
          <span>{fmtTime(r.created_at)}</span>
          {r.user_email && <><span>·</span><span>{r.user_email.split("@")[0]}</span></>}
        </div>
      </div>
      <button
        onClick={() => onDelete(r.id)}
        title="Remove from history"
        aria-label="Remove from history"
        style={{ border: "none", background: "none", cursor: "pointer", color: "var(--navy-3)", flex: "none", padding: 4 }}
      >
        <TrashIcon />
      </button>
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

function TargetCard({
  active, onClick, title, subtitle, blurb, examples,
}: {
  active: boolean; onClick: () => void; title: string; subtitle: string; blurb: string; examples: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: "left",
        border: `2px solid ${active ? "var(--coral)" : "var(--line, #d9d2c2)"}`,
        background: active ? "rgba(228,128,105,.07)" : "#fff",
        borderRadius: "var(--radius-sm, 14px)",
        padding: "14px 16px",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        transition: "border-color .12s, background .12s",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontSize: 17, fontWeight: 800, color: "var(--navy)" }}>{title}</span>
        <code style={{ fontSize: 11.5, color: "var(--navy-3)" }}>{subtitle}</code>
      </div>
      <div style={{ fontSize: 12.5, color: "var(--navy-2)", lineHeight: 1.4 }}>{blurb}</div>
      <div style={{ fontSize: 11.5, color: "var(--navy-3)", fontStyle: "italic" }}>{examples}</div>
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
