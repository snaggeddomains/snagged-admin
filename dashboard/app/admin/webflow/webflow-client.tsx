"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type Field = { id: string; slug: string; displayName?: string; type: string; isEditable?: boolean };
type Item = { id: string; isDraft?: boolean; isArchived?: boolean; lastPublished?: string | null; fieldData: Record<string, unknown> };
type Collection = { id: string; displayName?: string; slug?: string };
type Site = { id: string; displayName?: string };
type Overview = { ok: boolean; configured: boolean; canWrite?: boolean; sites?: Site[]; siteId?: string | null; collections?: Collection[]; marketplaceCollectionId?: string | null; error?: string };
type Detail = { ok: boolean; canWrite?: boolean; collection?: Collection; fields?: Field[]; items?: Item[]; total?: number; itemsError?: string | null; error?: string };

const card: CSSProperties = { border: "1px solid var(--line,#e3ddcf)", borderRadius: 12, padding: 16, background: "var(--paper,#fff)", marginBottom: 14 };
const btn: CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid var(--line,#e3ddcf)", background: "transparent", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)" };
const btnPrimary: CSSProperties = { ...btn, background: "var(--coral,#e2674a)", color: "#fff", borderColor: "var(--coral,#e2674a)" };
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const L: CSSProperties = { display: "block", fontSize: 11.5, fontWeight: 700, color: "var(--navy-2,#4a5b66)", margin: "9px 0 3px", textTransform: "uppercase", letterSpacing: ".02em" };

const asText = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
// Fields we can safely edit inline; others show read-only (reference/image/etc.).
const EDITABLE_TYPES = new Set(["PlainText", "RichText", "Number", "Switch", "Email", "Phone", "Link", "Color", "Option"]);

export default function WebflowClient() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [collId, setCollId] = useState<string>("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Item | null>(null);
  const canWrite = !!ov?.canWrite;

  // Overview (connection + collections).
  useEffect(() => {
    (async () => {
      setLoading(true); setErr(null);
      try {
        const res = await fetch("/api/admin/webflow", { cache: "no-store" });
        const j = (await res.json()) as Overview;
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setOv(j);
        if (j.configured) setCollId(j.marketplaceCollectionId || j.collections?.[0]?.id || "");
      } catch (e) { setErr(String((e as Error)?.message || e)); }
      finally { setLoading(false); }
    })();
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return; }
    setDetailLoading(true); setErr(null);
    try {
      const res = await fetch(`/api/admin/webflow?collection=${encodeURIComponent(id)}`, { cache: "no-store" });
      const j = (await res.json()) as Detail;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setDetail(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setDetailLoading(false); }
  }, []);
  useEffect(() => { if (collId) loadDetail(collId); }, [collId, loadDetail]);

  const fields = detail?.fields || [];
  // The primary "name" field + a few informative extras for the table columns.
  const primarySlug = useMemo(() => (fields.find((f) => f.slug === "name")?.slug || fields.find((f) => /name|domain|title/i.test(f.slug))?.slug || "name"), [fields]);
  const extraCols = useMemo(() => {
    const pref = fields.filter((f) => f.slug !== primarySlug && f.slug !== "slug" && /price|status|tld|sold|extension|category|for.?sale|active|listed/i.test(f.slug));
    const rest = fields.filter((f) => f.slug !== primarySlug && f.slug !== "slug" && !pref.includes(f) && EDITABLE_TYPES.has(f.type));
    return [...pref, ...rest].slice(0, 4);
  }, [fields, primarySlug]);

  const items = detail?.items || [];
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return items;
    return items.filter((it) => Object.values(it.fieldData).some((v) => asText(v).toLowerCase().includes(term)));
  }, [items, q]);

  const exportCsv = () => {
    const cols = [primarySlug, "slug", ...extraCols.map((f) => f.slug)];
    const head = cols.join(",");
    const rows = filtered.map((it) => cols.map((c) => `"${asText(it.fieldData[c]).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([[head, ...rows].join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = `webflow-${detail?.collection?.slug || "items"}.csv`; a.click();
  };

  if (loading) return <main><p className="muted">Loading…</p></main>;

  // Not connected yet — show the one-time setup.
  if (ov && !ov.configured) {
    return (
      <main style={{ maxWidth: 720, margin: "0 auto" }}>
        <h1 style={{ fontSize: "1.4rem" }}>Webflow CMS</h1>
        <div style={card}>
          <p style={{ marginTop: 0 }}><strong>Not connected yet.</strong> To pull + edit the Marketplace listings, add a Webflow <strong>Site API token</strong>:</p>
          <ol style={{ fontSize: 14, lineHeight: 1.7, paddingLeft: 20 }}>
            <li>In Webflow → your site → <strong>Site settings → Apps &amp; integrations → API access</strong>.</li>
            <li><strong>Generate API token</strong> with the <em>CMS: read &amp; write</em> scopes (and Sites: read).</li>
            <li>Add it to the admin Vercel project as <code>WEBFLOW_API_TOKEN</code>, then redeploy.</li>
            <li>(Optional) set <code>WEBFLOW_SITE_ID</code> / <code>WEBFLOW_MARKETPLACE_COLLECTION_ID</code> to pin them; otherwise they&apos;re auto-discovered.</li>
          </ol>
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 1120, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>Webflow CMS — Marketplace</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            {ov?.sites?.[0]?.displayName ? `Site: ${ov.sites[0].displayName} · ` : ""}
            {detail ? `${detail.total ?? items.length} items` : "Pull + edit the listings in your Webflow CMS."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <select style={{ ...input, width: "auto" }} value={collId} onChange={(e) => setCollId(e.target.value)} title="CMS collection">
            {(ov?.collections || []).map((c) => <option key={c.id} value={c.id}>{c.displayName || c.slug || c.id}</option>)}
          </select>
          <input style={{ ...input, minWidth: 180 }} placeholder="Search listings…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button style={btn} onClick={() => loadDetail(collId)} disabled={detailLoading}>{detailLoading ? "…" : "↻"}</button>
          <button style={btn} onClick={exportCsv} disabled={!filtered.length}>⬇ CSV</button>
        </div>
      </div>

      {err && <div style={{ margin: "12px 0", color: "#a83265" }}>{err}</div>}
      {detail?.itemsError && <div style={{ margin: "12px 0", color: "#a83265" }}>Items didn&apos;t fully load: {detail.itemsError}</div>}
      {ov?.configured && !canWrite && (
        <div style={{ margin: "12px 0", padding: "9px 12px", borderRadius: 8, background: "#fdf6e3", border: "1px solid #eadfba", fontSize: 12.5, color: "#7a5b00" }}>
          🔒 Connected with a <strong>read-only</strong> token — pulling works. To edit listings, add a write-scoped token as <code>WEBFLOW_API_TOKEN</code>.
        </div>
      )}

      <div style={{ ...card, marginTop: 14, overflowX: "auto" }}>
        {detailLoading ? <p className="muted">Loading listings…</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid var(--line,#e3ddcf)" }}>
                <th style={{ padding: "6px 10px" }}>{fields.find((f) => f.slug === primarySlug)?.displayName || "Name"}</th>
                {extraCols.map((f) => <th key={f.id} style={{ padding: "6px 10px" }}>{f.displayName || f.slug}</th>)}
                <th style={{ padding: "6px 10px" }}>Status</th>
                {canWrite && <th style={{ padding: "6px 10px" }}></th>}
              </tr>
            </thead>
            <tbody>
              {filtered.map((it) => (
                <tr key={it.id} style={{ borderBottom: "1px solid var(--line,#eee6d6)" }}>
                  <td style={{ padding: "6px 10px", fontWeight: 600 }}>{asText(it.fieldData[primarySlug]) || <span className="muted">—</span>}</td>
                  {extraCols.map((f) => <td key={f.id} style={{ padding: "6px 10px", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asText(it.fieldData[f.slug])}</td>)}
                  <td style={{ padding: "6px 10px", fontSize: 11.5 }}>
                    {it.isArchived ? <span style={{ color: "#7a6f63" }}>archived</span> : it.isDraft ? <span style={{ color: "#946200" }}>draft</span> : <span style={{ color: "#1f7a5a" }}>published</span>}
                  </td>
                  {canWrite && <td style={{ padding: "6px 10px", textAlign: "right" }}><button style={{ ...btn, padding: "3px 10px", fontSize: 12 }} onClick={() => setEditing(it)}>✎ Edit</button></td>}
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan={extraCols.length + (canWrite ? 3 : 2)} style={{ padding: 14, color: "var(--muted,#aab)" }}>{q ? "No listings match." : "No items in this collection."}</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <EditModal item={editing} fields={fields} collectionId={collId} nameSlug={primarySlug}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); loadDetail(collId); }} />
      )}
    </main>
  );
}

function EditModal({ item, fields, collectionId, nameSlug, onClose, onSaved }: {
  item: Item; fields: Field[]; collectionId: string; nameSlug: string; onClose: () => void; onSaved: () => void;
}) {
  const [vals, setVals] = useState<Record<string, unknown>>(() => ({ ...item.fieldData }));
  const [saving, setSaving] = useState(false);
  const [publish, setPublish] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const set = (slug: string, v: unknown) => setVals((s) => ({ ...s, [slug]: v }));
  const editable = fields.filter((f) => EDITABLE_TYPES.has(f.type));

  const save = async () => {
    setSaving(true); setError(null);
    // Only send fields that actually changed (PATCH merges — safest, no clobber).
    const fieldData: Record<string, unknown> = {};
    for (const f of editable) {
      const before = item.fieldData[f.slug], now = vals[f.slug];
      if (JSON.stringify(before ?? null) !== JSON.stringify(now ?? null)) fieldData[f.slug] = now;
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

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--paper,#fff)", borderRadius: 14, padding: 20, width: "min(520px,100%)", maxHeight: "92vh", overflowY: "auto" }}>
        <h2 style={{ fontSize: "1.15rem", margin: "0 0 8px" }}>✎ {asText(item.fieldData[nameSlug]) || "Edit listing"}</h2>
        {editable.map((f) => (
          <div key={f.id}>
            <label style={L}>{f.displayName || f.slug} <span style={{ fontWeight: 400, textTransform: "none", color: "var(--muted,#8a94a0)" }}>· {f.type}</span></label>
            {f.type === "Switch"
              ? <label style={{ display: "inline-flex", gap: 7, alignItems: "center", fontSize: 14 }}><input type="checkbox" checked={!!vals[f.slug]} onChange={(e) => set(f.slug, e.target.checked)} /> {vals[f.slug] ? "On" : "Off"}</label>
              : f.type === "RichText"
                ? <textarea style={{ ...input, width: "100%", minHeight: 90, resize: "vertical", fontFamily: "inherit" }} value={asText(vals[f.slug])} onChange={(e) => set(f.slug, e.target.value)} />
                : f.type === "Number"
                  ? <input style={{ ...input, width: "100%" }} inputMode="decimal" value={asText(vals[f.slug])} onChange={(e) => set(f.slug, e.target.value === "" ? null : Number(e.target.value))} />
                  : <input style={{ ...input, width: "100%" }} value={asText(vals[f.slug])} onChange={(e) => set(f.slug, e.target.value)} />}
          </div>
        ))}
        {error && <div style={{ color: "#a83265", fontSize: 13, marginTop: 10 }}>{error}</div>}
        <label style={{ display: "flex", gap: 7, alignItems: "center", fontSize: 13, marginTop: 14 }}>
          <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} /> Publish the change live (uncheck to just stage it in the CMS)
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
          <button style={btn} onClick={onClose} disabled={saving}>Cancel</button>
          <button style={btnPrimary} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}
