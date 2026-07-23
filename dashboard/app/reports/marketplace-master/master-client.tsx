"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type WfField = { id: string; slug: string; displayName?: string; type: string };
type WfItem = { id: string; isDraft?: boolean; isArchived?: boolean; lastPublished?: string | null; fieldData: Record<string, unknown>; refIds?: Record<string, unknown> };
type CollLite = { id: string; name: string; slug: string | null };
type RefOption = { id: string; name: string };
type Resp = { ok: boolean; configured: boolean; resolved?: boolean; canEdit?: boolean; collectionId?: string; collections?: CollLite[]; collectionName?: string | null; fields?: WfField[]; items?: WfItem[]; total?: number; refOptions?: Record<string, RefOption[]>; discoverError?: string | null; error?: string };
type EditCol = { field: WfField; label: string; kind: "money" | "text" | "bool" | "ref"; multi?: boolean };

const CORAL = "var(--coral-deep, #c0492f)";
const CTL: CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer" };
const BTN: CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer", whiteSpace: "nowrap" };
const asText = (v: unknown): string => v == null ? "" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v) : String(v);
const plain = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
const disp = (v: unknown): string => plain(asText(v));
const cell: CSSProperties = { padding: "7px 10px", borderBottom: "1px solid var(--line,#eee)", verticalAlign: "top" };
const th: CSSProperties = { ...cell, textAlign: "left", color: "var(--muted,#888)", fontWeight: 700, whiteSpace: "nowrap", background: "var(--paper-2,#f7f5ef)" };
const stateOf = (it: WfItem): "published" | "draft" | "archived" => it.isArchived ? "archived" : it.isDraft ? "draft" : "published";
const money = (v: unknown): string => { const n = Number(String(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 && String(v).trim() !== "" ? `$${n.toLocaleString()}` : disp(v); };

function StatusPill({ s }: { s: string }) {
  const c = s === "published" ? { bg: "#e4f2ea", fg: "#1f7a5a" } : s === "draft" ? { bg: "#fdf0d2", fg: "#946200" } : { bg: "#eee8e0", fg: "#7a6f63" };
  return <span style={{ fontSize: 11, fontWeight: 700, background: c.bg, color: c.fg, borderRadius: 999, padding: "2px 9px", textTransform: "capitalize" }}>{s}</span>;
}
function BoolPill({ on }: { on: boolean }) {
  return on
    ? <span style={{ fontSize: 11, fontWeight: 700, background: "#e6f2f7", color: "#146c8f", borderRadius: 999, padding: "2px 9px" }}>Yes</span>
    : <span style={{ fontSize: 11, color: "var(--muted,#aab)" }}>—</span>;
}
function Pills({ raw }: { raw: string }) {
  const parts = raw.split(/,\s*/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return <span className="muted">—</span>;
  return (
    <span style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {parts.map((p, i) => <span key={i} style={{ fontSize: 11.5, fontWeight: 600, background: "#eef2f4", color: "var(--navy,#254254)", border: "1px solid #dbe4e8", borderRadius: 999, padding: "1px 8px" }}>{p}</span>)}
    </span>
  );
}

export default function MasterClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [statusF, setStatusF] = useState<"published" | "draft" | "archived" | "all">("published");
  const [collId, setCollId] = useState("");
  const [editing, setEditing] = useState<WfItem | null>(null);
  const canEdit = !!data?.canEdit;

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const qs = new URLSearchParams({ all: "1" });
      if (collId) qs.set("collection", collId);
      const res = await fetch(`/api/admin/marketplace/live?${qs.toString()}`, { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, [collId]);
  useEffect(() => { void load(); }, [load]);

  const fields = data?.fields || [];
  // Curated, ordered columns (drop Domain Logo / Slug / the rest). Matched flexibly by
  // slug or display name so it survives small CMS renames.
  const cols = useMemo(() => {
    const find = (re: RegExp) => fields.find((f) => re.test(f.slug) || re.test(f.displayName || ""));
    const exact = (name: string) => fields.find((f) => f.slug === name || (f.displayName || "").toLowerCase() === name);
    const spec: { field?: WfField; label: string; kind: "money" | "text" | "bool" | "pills" }[] = [
      { field: find(/asking/i) || find(/\bprice\b/i), label: "Asking price", kind: "money" },
      { field: find(/min.*offer|minimum.*offer|min.?offer/i), label: "Min offer", kind: "money" },
      { field: find(/one.?liner/i), label: "One-liner", kind: "text" },
      { field: exact("description"), label: "Description", kind: "text" },
      { field: find(/featured/i), label: "Featured", kind: "bool" },
      { field: find(/premium/i), label: "Premium", kind: "bool" },
      { field: find(/hand.?pick/i), label: "Hand-picked", kind: "bool" },
      { field: find(/extension/i), label: "Extension", kind: "pills" },
      { field: find(/categor/i), label: "Categories", kind: "pills" },
    ];
    const seen = new Set<string>();
    return spec.filter((c) => c.field && !seen.has(c.field.id) && seen.add(c.field.id)) as { field: WfField; label: string; kind: "money" | "text" | "bool" | "pills" }[];
  }, [fields]);
  const nameSlug = useMemo(() => (fields.find((f) => f.slug === "name")?.slug || fields.find((f) => /^name$|domain|title/i.test(f.slug))?.slug || "name"), [fields]);
  // Editable set for the modal = Name + the curated non-reference fields (Extension/Categories
  // are references — not editable here). Values come from the raw fieldData.
  const editCols = useMemo<EditCol[]>(() => {
    const nameF = fields.find((f) => f.slug === nameSlug);
    const head: EditCol[] = nameF ? [{ field: nameF, label: "Name", kind: "text" }] : [];
    // Include EVERY curated field: the plain ones + the reference fields (Extension / Categories),
    // which become single/multi selects (multi = a MultiReference type).
    return [...head, ...cols.map((c) => c.kind === "pills"
      ? { field: c.field, label: c.label, kind: "ref" as const, multi: /multi/i.test(c.field.type) }
      : { field: c.field, label: c.label, kind: c.kind as EditCol["kind"] })];
  }, [fields, nameSlug, cols]);

  const items = data?.items || [];
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return items.filter((it) => (statusF === "all" || stateOf(it) === statusF) && (!t || Object.values(it.fieldData).some((v) => disp(v).toLowerCase().includes(t))));
  }, [items, q, statusF]);
  const counts = useMemo(() => {
    const c = { published: 0, draft: 0, archived: 0 };
    for (const it of items) c[stateOf(it)]++;
    return c;
  }, [items]);

  const exportCsv = () => {
    const head = ["Name", "Status", ...cols.map((c) => c.label)].join(",");
    const body = rows.map((it) => [disp(it.fieldData[nameSlug]), stateOf(it), ...cols.map((c) => c.kind === "money" ? money(it.fieldData[c.field.slug]) : disp(it.fieldData[c.field.slug]))].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([head + "\n" + body], { type: "text/csv" }));
    a.download = "marketplace-master.csv"; a.click();
  };

  return (
    <main>
      {/* Grow the centered column to full window width so the wide table doesn't cut off. */}
      <div data-wide-page hidden />
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>
        Marketplace Master
        <span style={{ marginLeft: 10, fontSize: 11.5, fontWeight: 700, color: "#146c8f", background: "#e6f2f7", border: "1px solid #bfe0eb", borderRadius: 999, padding: "2px 9px", verticalAlign: "middle" }}>◆ Source: Webflow CMS</span>
      </h1>
      <p className="section-blurb" style={{ marginTop: 0 }}>The Marketplace domains from Webflow{data?.collectionName ? ` (${data.collectionName})` : ""} — asking price, minimum offer, descriptions, flags, extension &amp; categories. Read-only.</p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
        {(data?.collections?.length ?? 0) > 0 && (
          <select style={CTL} value={collId || data?.collectionId || ""} onChange={(e) => setCollId(e.target.value)} title="CMS collection">
            {data!.collections!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select style={CTL} value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} title="Filter by status">
          <option value="published">Published ({counts.published})</option>
          <option value="draft">Draft ({counts.draft})</option>
          <option value="archived">Archived ({counts.archived})</option>
          <option value="all">All ({items.length})</option>
        </select>
        <input style={{ ...CTL, minWidth: 200 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={BTN} onClick={() => void load()} disabled={loading}>{loading ? "working…" : "↻ Refresh"}</button>
        <button style={BTN} onClick={exportCsv} disabled={!rows.length}>⬇ CSV</button>
        {data && <span className="muted" style={{ fontSize: 12 }}>{rows.length} shown</span>}
      </div>

      {err && <p style={{ color: CORAL }}>{err}</p>}
      {data && !data.configured && <p className="muted">Webflow isn&apos;t connected on this deployment.</p>}
      {data && data.configured && data.resolved === false && (
        <p className="muted">
          {(data.collections?.length ?? 0) > 0
            ? "Pick the collection above (the domains listing) to load it."
            : <>Couldn&apos;t list collections{data.discoverError ? ` (${data.discoverError})` : ""} — set <code>WEBFLOW_MARKETPLACE_COLLECTION_ID=6998a906939f81e325694dc9</code> in Vercel.</>}
        </p>
      )}

      {data?.configured && data.resolved !== false && (
        <div style={{ overflowX: "auto", marginTop: 12, border: "1px solid var(--line,#e3ddcf)", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5, width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...th, position: "sticky", left: 0, zIndex: 1 }}>Name</th>
                <th style={th}>Published</th>
                {cols.map((c) => <th key={c.field.id} style={th} title={`${c.field.slug} · ${c.field.type}`}>{c.label}</th>)}
                {canEdit && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.id}>
                  <td style={{ ...cell, position: "sticky", left: 0, background: "var(--paper,#fff)", fontWeight: 700, whiteSpace: "nowrap" }}>
                    {disp(it.fieldData[nameSlug]) || <span className="muted">—</span>}
                    {disp(it.fieldData.slug) && <a href={`https://www.snagged.com/domains/${disp(it.fieldData.slug)}`} target="_blank" rel="noreferrer" title="Open listing" style={{ color: "var(--muted,#888)", textDecoration: "none", marginLeft: 6, fontSize: 12 }}>↗</a>}
                  </td>
                  <td style={cell}><StatusPill s={stateOf(it)} /></td>
                  {cols.map((c) => {
                    const v = it.fieldData[c.field.slug];
                    return (
                      <td key={c.field.id} style={{ ...cell, ...(c.kind === "text" ? { maxWidth: 320, whiteSpace: "normal", wordBreak: "break-word", color: "var(--navy-2,#4a5b66)" } : { whiteSpace: "nowrap" }) }}>
                        {c.kind === "bool" ? <BoolPill on={!!v} />
                          : c.kind === "pills" ? <Pills raw={disp(v)} />
                            : c.kind === "money" ? (money(v) || <span className="muted">—</span>)
                              : (disp(v) || <span className="muted">—</span>)}
                      </td>
                    );
                  })}
                  {canEdit && <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}><button style={{ ...BTN, padding: "3px 10px", fontSize: 12 }} onClick={() => setEditing(it)}>✎ Edit</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && <p className="muted" style={{ padding: 12 }}>{q || statusF !== "all" ? "No listings match." : "No listings found."}</p>}
        </div>
      )}

      {editing && data?.collectionId && (
        <EditModal item={editing} cols={editCols} nameSlug={nameSlug} collectionId={data.collectionId} refOptions={data.refOptions || {}}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      )}
    </main>
  );
}

// Edit one listing — Name, the plain fields, AND the reference fields (Extension = single
// select, Categories = multi-select) from their option lists. RichText edited as plain text
// (re-wrapped in <p> on save); Number→number; Switch→bool; references send item id(s). Only
// CHANGED fields are sent (PATCH merges).
function EditModal({ item, cols, nameSlug, collectionId, refOptions, onClose, onSaved }: {
  item: WfItem; cols: EditCol[]; nameSlug: string; collectionId: string; refOptions: Record<string, RefOption[]>; onClose: () => void; onSaved: () => void;
}) {
  const isRich = (f: WfField) => /richtext/i.test(f.type);
  const refOf = (slug: string): unknown => (item.refIds || {})[slug];
  const initial = () => {
    const o: Record<string, unknown> = {};
    for (const c of cols) {
      if (c.kind === "ref") { const v = refOf(c.field.slug); o[c.field.slug] = c.multi ? (Array.isArray(v) ? v : v ? [v] : []) : (typeof v === "string" ? v : ""); }
      else { const raw = item.fieldData[c.field.slug]; o[c.field.slug] = c.kind === "bool" ? !!raw : isRich(c.field) ? plain(asText(raw)) : asText(raw); }
    }
    return o;
  };
  const [vals, setVals] = useState<Record<string, unknown>>(initial);
  const [publish, setPublish] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (slug: string, v: unknown) => setVals((s) => ({ ...s, [slug]: v }));
  const toggleMulti = (slug: string, id: string) => setVals((s) => {
    const arr = Array.isArray(s[slug]) ? [...(s[slug] as string[])] : [];
    const i = arr.indexOf(id); if (i >= 0) arr.splice(i, 1); else arr.push(id);
    return { ...s, [slug]: arr };
  });

  const save = async () => {
    setSaving(true); setError(null);
    const fieldData: Record<string, unknown> = {};
    for (const c of cols) {
      const f = c.field, now = vals[f.slug];
      let out: unknown, before: unknown;
      if (c.kind === "ref") {
        if (c.multi) { out = Array.isArray(now) ? now : []; before = Array.isArray(refOf(f.slug)) ? refOf(f.slug) : (refOf(f.slug) ? [refOf(f.slug)] : []); }
        else { out = now || null; before = (typeof refOf(f.slug) === "string" ? refOf(f.slug) : null); }
      } else if (c.kind === "bool") { out = !!now; before = !!item.fieldData[f.slug]; }
      else if (isRich(f)) { out = String(now || "").trim() ? `<p>${String(now)}</p>` : ""; before = plain(asText(item.fieldData[f.slug])).trim() ? `<p>${plain(asText(item.fieldData[f.slug]))}</p>` : ""; }
      else if (f.type === "Number") { out = now === "" || now == null ? null : Number(String(now).replace(/[^0-9.]/g, "")); before = item.fieldData[f.slug] ?? null; }
      else { out = now; before = asText(item.fieldData[f.slug]); }
      if (JSON.stringify(before ?? null) !== JSON.stringify(out ?? null)) fieldData[f.slug] = out;
    }
    if (!Object.keys(fieldData).length) { onClose(); return; }
    try {
      const res = await fetch("/api/admin/webflow", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", collection: collectionId, itemId: item.id, fieldData, publish }) });
      const j = await res.json();
      if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
      onSaved();
    } catch (e) { setError(String((e as Error)?.message || e)); setSaving(false); }
  };

  const L: CSSProperties = { display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "10px 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };
  const inp: CSSProperties = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(520px,100%)", maxHeight: "92vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.15rem", margin: "0 0 8px" }}>✎ {disp(item.fieldData[nameSlug]) || "Edit listing"}</h2>
        {cols.map((c) => {
          const opts = refOptions[c.field.slug] || [];
          return (
            <div key={c.field.id}>
              <label style={L}>{c.label}</label>
              {c.kind === "bool"
                ? <label style={{ display: "inline-flex", gap: 7, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={!!vals[c.field.slug]} onChange={(e) => set(c.field.slug, e.target.checked)} /> {vals[c.field.slug] ? "Yes" : "No"}</label>
                : c.kind === "ref" && c.multi
                  ? <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {opts.map((o) => { const on = Array.isArray(vals[c.field.slug]) && (vals[c.field.slug] as string[]).includes(o.id); return (
                        <button key={o.id} type="button" onClick={() => toggleMulti(c.field.slug, o.id)}
                          style={{ fontSize: 12.5, fontWeight: 600, borderRadius: 999, padding: "3px 11px", cursor: "pointer", border: `1px solid ${on ? "#146c8f" : "#dbe4e8"}`, background: on ? "#146c8f" : "#eef2f4", color: on ? "#fff" : "var(--navy,#254254)" }}>{o.name}</button>
                      ); })}
                      {!opts.length && <span className="muted" style={{ fontSize: 12 }}>No options available.</span>}
                    </div>
                  : c.kind === "ref"
                    ? <select style={inp} value={String(vals[c.field.slug] ?? "")} onChange={(e) => set(c.field.slug, e.target.value)}>
                        <option value="">—</option>
                        {opts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    : isRich(c.field)
                      ? <textarea style={{ ...inp, minHeight: 70, resize: "vertical", fontFamily: "inherit" }} value={String(vals[c.field.slug] ?? "")} onChange={(e) => set(c.field.slug, e.target.value)} />
                      : <input style={inp} inputMode={c.kind === "money" ? "decimal" : undefined} value={String(vals[c.field.slug] ?? "")} onChange={(e) => set(c.field.slug, e.target.value)} />}
            </div>
          );
        })}
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, marginTop: 14 }}>
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish the change live (uncheck to just stage it)
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button style={BTN} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={{ ...BTN, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" }} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
