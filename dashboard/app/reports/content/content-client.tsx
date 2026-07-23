"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import CrosslinksView from "./crosslinks-view";

type WfField = { id: string; slug: string; displayName?: string; type: string };
type WfItem = { id: string; isDraft?: boolean; isArchived?: boolean; fieldData: Record<string, unknown> };
type Resp = { ok: boolean; configured: boolean; resolved?: boolean; collectionName?: string | null; fields?: WfField[]; items?: WfItem[]; total?: number; error?: string };

const CORAL = "var(--coral-deep, #c0492f)";
const CTL: CSSProperties = { padding: "5px 9px", fontSize: 13, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)" };
const BTN: CSSProperties = { padding: "5px 11px", fontSize: 12.5, borderRadius: 8, border: "1px solid #d8d0bf", background: "#fff", color: "var(--navy,#254254)", cursor: "pointer", whiteSpace: "nowrap" };
const asText = (v: unknown): string => v == null ? "" : typeof v === "object" ? (Array.isArray(v) ? v.join(", ") : JSON.stringify(v)) : String(v);
const plain = (s: string): string => s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;/gi, '"').replace(/\s+/g, " ").trim();
const disp = (v: unknown): string => plain(asText(v));
const cell: CSSProperties = { padding: "8px 10px", borderBottom: "1px solid var(--line,#eee)", verticalAlign: "middle" };
const th: CSSProperties = { ...cell, textAlign: "left", color: "var(--muted,#888)", fontWeight: 700, whiteSpace: "nowrap", background: "var(--paper-2,#f7f5ef)" };
const seg = (active: boolean): CSSProperties => ({ padding: "5px 12px", fontSize: 13, fontWeight: 600, borderRadius: 8, border: "1px solid #d8d0bf", cursor: "pointer", background: active ? "var(--navy,#254254)" : "#fff", color: active ? "#fff" : "var(--navy,#254254)" });

export default function ContentClient() {
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"posts" | "crosslinks">("posts");

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/admin/content/blog", { cache: "no-store" });
      const j = (await res.json()) as Resp;
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setData(j);
    } catch (e) { setErr(String((e as Error)?.message || e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const fields = data?.fields || [];
  const slugOf = useMemo(() => {
    const find = (re: RegExp) => fields.find((f) => re.test(f.slug) || re.test(f.displayName || ""))?.slug;
    return {
      title: fields.find((f) => f.slug === "name")?.slug || find(/title|name/i) || "name",
      urlSlug: fields.find((f) => f.slug === "slug")?.slug || "slug",
      summary: find(/summary|excerpt/i) || find(/one.?liner|description|subtitle/i) || null,
      author: find(/author|written.?by|by.?line/i) || null,
      category: find(/categor/i) || null,
    };
  }, [fields]);

  const items = data?.items || [];
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? items.filter((it) => Object.values(it.fieldData).some((v) => disp(v).toLowerCase().includes(t))) : items;
  }, [items, q]);

  const exportCsv = () => {
    const cols = [["Title", slugOf.title], ["Summary", slugOf.summary], ["Author", slugOf.author], ["Category", slugOf.category]] as const;
    const head = cols.map(([label]) => label).join(",");
    const body = rows.map((it) => cols.map(([, s]) => `"${(s ? disp(it.fieldData[s]) : "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([head + "\n" + body], { type: "text/csv" }));
    a.download = "content-blog-posts.csv"; a.click();
  };

  return (
    <main>
      <div data-wide-page hidden />
      <h1 style={{ fontSize: "1.25rem", marginBottom: 4 }}>
        Content
        <span style={{ marginLeft: 10, fontSize: 11.5, fontWeight: 700, color: "#146c8f", background: "#e6f2f7", border: "1px solid #bfe0eb", borderRadius: 999, padding: "2px 9px", verticalAlign: "middle" }}>◆ Source: Webflow</span>
      </h1>
      <div style={{ display: "flex", gap: 6, margin: "8px 0 4px" }}>
        <button onClick={() => setTab("posts")} style={seg(tab === "posts")}>Posts</button>
        <button onClick={() => setTab("crosslinks")} style={seg(tab === "crosslinks")}>Crosslinking</button>
      </div>

      {tab === "crosslinks" ? <CrosslinksView /> : (<>
      <p className="section-blurb" style={{ marginTop: 0 }}>Blog posts from the Webflow CMS.</p>

      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: "10px 0 4px" }}>
        <input style={{ ...CTL, minWidth: 220 }} placeholder="Search posts…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button style={BTN} onClick={() => void load()} disabled={loading}>{loading ? "working…" : "↻ Refresh"}</button>
        <button style={BTN} onClick={exportCsv} disabled={!rows.length}>⬇ CSV</button>
        {data && <span className="muted" style={{ fontSize: 12 }}>{q ? `${rows.length} / ${data.total ?? items.length}` : `${data.total ?? items.length}`} posts</span>}
      </div>

      {err && <p style={{ color: CORAL }}>{err}</p>}
      {data && !data.configured && <p className="muted">Webflow isn&apos;t connected on this deployment.</p>}
      {data && data.configured && data.resolved === false && <p className="muted">Set <code>WEBFLOW_BLOG_POSTS_ID</code> to the Blog Posts collection id.</p>}

      {data?.configured && data.resolved !== false && (
        <div style={{ overflowX: "auto", marginTop: 12, border: "1px solid var(--line,#e3ddcf)", borderRadius: 10 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 13, width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>Title</th>
                {slugOf.summary && <th style={th}>Summary</th>}
                {slugOf.author && <th style={th}>Author</th>}
                {slugOf.category && <th style={th}>Category</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((it) => {
                const title = disp(it.fieldData[slugOf.title]);
                const slug = disp(it.fieldData[slugOf.urlSlug]);
                return (
                  <tr key={it.id}>
                    <td style={{ ...cell, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {title || <span className="muted">—</span>}
                      {slug && <a href={`https://www.snagged.com/post/${slug}`} target="_blank" rel="noreferrer" title="Open post" style={{ color: "var(--muted,#888)", textDecoration: "none", marginLeft: 6, fontSize: 12 }}>↗</a>}
                    </td>
                    {slugOf.summary && <td style={{ ...cell, maxWidth: 460, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: "var(--navy-2,#4a5b66)" }} title={disp(it.fieldData[slugOf.summary])}>{disp(it.fieldData[slugOf.summary]) || <span className="muted">—</span>}</td>}
                    {slugOf.author && <td style={{ ...cell, whiteSpace: "nowrap" }}>{disp(it.fieldData[slugOf.author]) || <span className="muted">—</span>}</td>}
                    {slugOf.category && <td style={{ ...cell, whiteSpace: "nowrap" }}>{disp(it.fieldData[slugOf.category]) ? <span style={{ fontSize: 11.5, fontWeight: 600, background: "#eef2f4", color: "var(--navy,#254254)", border: "1px solid #dbe4e8", borderRadius: 999, padding: "1px 8px" }}>{disp(it.fieldData[slugOf.category])}</span> : <span className="muted">—</span>}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!loading && !rows.length && <p className="muted" style={{ padding: 12 }}>{q ? "No posts match." : "No posts found."}</p>}
        </div>
      )}
      </>)}
    </main>
  );
}
