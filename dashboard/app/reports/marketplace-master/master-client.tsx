"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type WfField = { id: string; slug: string; displayName?: string; type: string };
type WfItem = { id: string; isDraft?: boolean; isArchived?: boolean; lastPublished?: string | null; fieldData: Record<string, unknown> };
type CollLite = { id: string; name: string; slug: string | null };
type Resp = { ok: boolean; configured: boolean; resolved?: boolean; collectionId?: string; collections?: CollLite[]; collectionName?: string | null; fields?: WfField[]; items?: WfItem[]; total?: number; discoverError?: string | null; error?: string };

const CORAL = "var(--coral-deep, #c0492f)";
const CTL: CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer" };
const BTN: CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer", whiteSpace: "nowrap" };
const asText = (v: unknown): string => v == null ? "" : typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? JSON.stringify(v) : String(v);
// RichText fields (One-liner / Description) come back as HTML — show readable plain text.
const plain = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
const disp = (v: unknown): string => plain(asText(v));
const cell: CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--line,#eee)", verticalAlign: "top" };

export default function MasterClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [wrap, setWrap] = useState(false); // wrap long cells vs. single-line + ellipsis
  const [collId, setCollId] = useState(""); // manual collection pick (when auto-detect can't)

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

  // Every CMS field is a column. Put the name field first, then the rest in schema order.
  const fields = useMemo(() => {
    const fs = data?.fields || [];
    const nameIdx = fs.findIndex((f) => f.slug === "name");
    if (nameIdx > 0) { const copy = [...fs]; const [n] = copy.splice(nameIdx, 1); copy.unshift(n); return copy; }
    return fs;
  }, [data]);
  const items = data?.items || [];
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((it) => Object.values(it.fieldData).some((v) => disp(v).toLowerCase().includes(t))) : items;
  }, [items, q]);

  const exportCsv = () => {
    const cols = ["_status", ...fields.map((f) => f.slug)];
    const head = ["Status", ...fields.map((f) => f.displayName || f.slug)].join(",");
    const body = rows.map((it) => cols.map((c) => {
      const val = c === "_status" ? (it.isArchived ? "archived" : it.isDraft ? "draft" : "published") : disp(it.fieldData[c]);
      return `"${val.replace(/"/g, '""')}"`;
    }).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([head + "\n" + body], { type: "text/csv" }));
    a.download = "marketplace-master.csv"; a.click();
  };

  return (
    <main>
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>
        Marketplace Master
        <span style={{ marginLeft: 10, fontSize: 11.5, fontWeight: 700, color: "#146c8f", background: "#e6f2f7", border: "1px solid #bfe0eb", borderRadius: 999, padding: "2px 9px", verticalAlign: "middle" }}>◆ Source: Webflow CMS</span>
      </h1>
      <p className="section-blurb" style={{ marginTop: 0 }}>
        Every listing with <strong>all its Webflow CMS fields</strong> — one-line description, description, extension, categories, and the rest —
        pulled live from the Marketplace collection{data?.collectionName ? ` (${data.collectionName})` : ""}. Read-only.
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
        {(data?.collections?.length ?? 0) > 0 && (
          <select style={CTL} value={collId || data?.collectionId || ""} onChange={(e) => setCollId(e.target.value)} title="CMS collection">
            {data!.collections!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <input style={{ ...CTL, minWidth: 200 }} placeholder="Search across all fields…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={BTN} onClick={() => void load()} disabled={loading}>{loading ? "working…" : "↻ Refresh"}</button>
        <button style={BTN} onClick={exportCsv} disabled={!rows.length}>⬇ CSV</button>
        <label style={{ fontSize: 12.5, display: "inline-flex", alignItems: "center", gap: 5, cursor: "pointer" }}>
          <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap long text
        </label>
        {data && <span className="muted" style={{ fontSize: 12 }}>{q ? `${rows.length} / ${data.total ?? items.length}` : `${data.total ?? items.length}`} listings · {fields.length} fields</span>}
      </div>

      {err && <p style={{ color: CORAL }}>{err}</p>}
      {data && !data.configured && <p className="muted">Webflow isn&apos;t connected on this deployment (set <code>WEBFLOW_API_TOKEN_CMS_READ_ONLY</code>).</p>}
      {data && data.configured && data.resolved === false && (
        <p className="muted">
          {(data.collections?.length ?? 0) > 0
            ? "Pick the collection above (the domains listing) to load it."
            : <>Couldn&apos;t list collections{data.discoverError ? ` (${data.discoverError})` : ""} — the read-only token may lack <em>Sites: read</em>. Set <code>WEBFLOW_MARKETPLACE_COLLECTION_ID=6998a906939f81e325694dc9</code> in Vercel to pin the Domains collection.</>}
        </p>
      )}

      {data?.configured && data.resolved !== false && (
        <div style={{ overflowX: "auto", marginTop: 12, border: "1px solid var(--line,#e3ddcf)", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: "var(--paper-2,#f7f5ef)" }}>
                <th style={{ ...cell, textAlign: "left", position: "sticky", left: 0, background: "var(--paper-2,#f7f5ef)", color: "var(--muted,#888)", fontWeight: 700 }}>Status</th>
                {fields.map((f) => (
                  <th key={f.id} style={{ ...cell, textAlign: "left", color: "var(--muted,#888)", fontWeight: 700, whiteSpace: "nowrap" }} title={`${f.slug} · ${f.type}`}>{f.displayName || f.slug}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => (
                <tr key={it.id}>
                  <td style={{ ...cell, position: "sticky", left: 0, background: "var(--paper,#fff)", fontSize: 11, whiteSpace: "nowrap" }}>
                    {it.isArchived ? <span style={{ color: "#7a6f63" }}>archived</span> : it.isDraft ? <span style={{ color: "#946200" }}>draft</span> : <span style={{ color: "#1f7a5a" }}>published</span>}
                  </td>
                  {fields.map((f) => {
                    const raw = disp(it.fieldData[f.slug]);
                    return (
                      <td key={f.id} style={{ ...cell, maxWidth: wrap ? 320 : 260, ...(wrap ? { whiteSpace: "normal", wordBreak: "break-word" } : { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }), fontWeight: f.slug === "name" ? 600 : 400 }} title={raw}>
                        {raw || <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && <p className="muted" style={{ padding: 12 }}>{q ? "No listings match." : "No listings found."}</p>}
        </div>
      )}
    </main>
  );
}
