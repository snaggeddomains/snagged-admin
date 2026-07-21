"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

type Deal = {
  id: string; domain: string; buyer_name: string | null; buyer_email: string | null;
  budget_range: string | null; asking_price: number | null; appraisal_value: number | null;
  source: string | null; priority: string | null; owner_email: string | null; stage: string; status: string; updated_at: string;
};
type Resp = { ok: boolean; deals: Deal[]; assignees: { email: string; name: string }[]; error?: string };

const usd = (n: number | null | undefined) => (n == null || n === 0 ? "—" : `$${Math.round(n).toLocaleString()}`);
const input: CSSProperties = { padding: "7px 9px", borderRadius: 7, border: "1px solid var(--line,#e3ddcf)", fontSize: 14, boxSizing: "border-box" };
const th: CSSProperties = { textAlign: "left", padding: "0 14px 6px 0", fontSize: 11, textTransform: "uppercase", letterSpacing: ".03em", color: "var(--muted,#889)", whiteSpace: "nowrap" };
const td: CSSProperties = { padding: "8px 14px 8px 0", fontSize: 13.5, borderTop: "1px solid var(--line,#eee)", whiteSpace: "nowrap" };

export default function ListClient() {
  const router = useRouter();
  const [data, setData] = useState<Resp | null>(null);
  const [status, setStatus] = useState("open");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ k: string; dir: 1 | -1 }>({ k: "updated_at", dir: -1 });

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (q) p.set("q", q);
    const res = await fetch(`/api/admin/deals?${p}`, { cache: "no-store" });
    setData(await res.json());
  }, [status, q]);
  useEffect(() => { load(); }, [load]);

  const nameFor = useMemo(() => {
    const m = new Map((data?.assignees || []).map((a) => [a.email.toLowerCase(), a.name]));
    return (e: string | null) => e ? (m.get(e.toLowerCase()) || e.split("@")[0]) : "Inbox";
  }, [data]);

  const rows = useMemo(() => {
    const ds = [...(data?.deals || [])];
    const val = (d: Deal) => d.asking_price || d.appraisal_value || 0;
    ds.sort((a, b) => {
      let av: string | number, bv: string | number;
      if (sort.k === "value") { av = val(a); bv = val(b); }
      else { av = (a as unknown as Record<string, string>)[sort.k] || ""; bv = (b as unknown as Record<string, string>)[sort.k] || ""; }
      return (av < bv ? -1 : av > bv ? 1 : 0) * sort.dir;
    });
    return ds;
  }, [data, sort]);

  const H = ({ k, label }: { k: string; label: string }) => (
    <th style={{ ...th, cursor: "pointer" }} onClick={() => setSort((s) => ({ k, dir: s.k === k && s.dir === 1 ? -1 : 1 }))}>
      {label}{sort.k === k ? (sort.dir === 1 ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <main style={{ width: "100%", padding: "0 12px", boxSizing: "border-box" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 10 }}>
        <h1 style={{ fontSize: "1.35rem", margin: 0 }}>Deals — list</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...input, width: 220 }} placeholder="Search domain / buyer…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} />
          <select style={input} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="open">Open</option><option value="won">Won</option><option value="lost">Lost</option><option value="all">All</option>
          </select>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: "4px 0 12px" }}>{rows.length} deal{rows.length === 1 ? "" : "s"}</p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr><H k="domain" label="Domain" /><H k="buyer_name" label="Buyer" /><H k="owner_email" label="Owner" /><H k="stage" label="Stage" /><H k="status" label="Status" /><H k="budget_range" label="Budget" /><H k="value" label="Asking" /><H k="priority" label="Priority" /><H k="updated_at" label="Updated" /></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} onClick={() => router.push(`/deals/${d.id}`)} style={{ cursor: "pointer" }}>
                <td style={{ ...td, fontWeight: 700, color: "var(--navy,#254254)" }}>{d.domain}</td>
                <td style={td}>{d.buyer_name || d.buyer_email || "—"}</td>
                <td style={td}>{nameFor(d.owner_email)}</td>
                <td style={td}>{d.stage}</td>
                <td style={{ ...td, fontWeight: 600, color: d.status === "won" ? "#1f7a5a" : d.status === "lost" ? "#a83265" : "inherit" }}>{d.status}</td>
                <td style={td}>{d.budget_range || "—"}</td>
                <td style={td}>{usd(d.asking_price || d.appraisal_value)}</td>
                <td style={td}>{d.priority || "—"}</td>
                <td style={{ ...td, color: "var(--muted,#889)" }}>{d.updated_at ? new Date(d.updated_at).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {!rows.length && <tr><td style={{ ...td, color: "var(--muted,#aab)" }} colSpan={9}>No deals.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}
