"use client";

// Client-side source rows for the admin dashboard. The server page
// (app/admin/page.tsx) precomputes a serializable RowVM per source; here we
// render the row and make the "new today" count an expandable drill-down that
// lazily fetches the actual names (via /api/admin/source-domains), mirroring the
// imports tool's "view qualifying domains".

import { useState } from "react";
import KindPill from "@/app/kind-pill";

export type RowVM = {
  sourceId: string;
  kind: string;
  statusKey: string;
  statusLabel: string;
  dim: boolean;
  todo: boolean;
  scheduleLabel: string;
  scheduleVia?: string;
  lastRun: string;
  newCount: number | null;
  wired: boolean;
  runHref: string;
  codeHref: string;
  editHref: string;
};

type Dom = {
  domain: string;
  quality_score: number | null;
  category: string | null;
  enriched: boolean;
  price: number | null;
  best_price_source: string | null;
};

const COLS = 6;

// Best-effort link to where the domain is listed for sale, by marketplace.
// Falls back to the domain's own URL (parked/for-sale landers usually live there).
function forSaleUrl(source: string | null, domain: string): string {
  const s = (source || "").toLowerCase();
  const label = domain.split(".")[0];
  const d = encodeURIComponent(domain);
  if (s.includes("afternic")) return `https://www.afternic.com/domain/${domain}`;
  if (s.includes("atom")) return `https://www.atom.com/name/${encodeURIComponent(label)}`;
  if (s.includes("sedo")) return `https://sedo.com/search/?keyword=${d}`;
  if (s.includes("dan")) return `https://dan.com/buy-domain/${domain}`;
  if (s.includes("dropcatch")) return `https://www.dropcatch.com/domain/${domain}`;
  if (s.includes("namejet")) return `https://www.namejet.com/Pages/Auctions/BackorderDetails.aspx?domainname=${d}`;
  if (s.includes("godaddy")) return `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}`;
  if (s.includes("namecheap")) return `https://www.namecheap.com/market/?term=${d}`;
  if (s.includes("brandbucket")) return `https://www.brandbucket.com/search?search=${encodeURIComponent(label)}`;
  if (s.includes("oxley")) return `https://oxley.io/domain/${domain}`;
  return `https://${domain}`;
}
function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  return `$${Math.round(p).toLocaleString()}`;
}

function LinkOut({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link-out">
      {label} →
    </a>
  );
}

function NewTodayList({
  list,
  origin,
  sourceId,
}: {
  list: Dom[] | null | "loading";
  origin: string | null;
  sourceId: string;
}) {
  if (list === "loading")
    return <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>loading domains…</div>;
  if (list === null)
    return <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>couldn’t load domains.</div>;
  if (!list.length)
    return (
      <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>
        no new names recorded today
        {origin === "universe" ? " (none net-new to the universe)" : ""}.
      </div>
    );
  return (
    <div style={{ border: "1px solid var(--line, #e3ddcf)", borderRadius: 10, overflow: "hidden", margin: "4px 0 8px" }}>
      {origin === "universe" && (
        <div className="muted" style={{ fontSize: 11.5, padding: "6px 12px", background: "var(--cream-2, #fbf7ec)" }}>
          showing names net-new to the universe today (feed list not yet recorded for this source)
        </div>
      )}
      <div style={{ maxHeight: 320, overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--navy-3)", background: "var(--cream-2, #fbf7ec)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 12px" }}>Domain</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Quality</th>
              <th style={{ padding: "6px 12px", textAlign: "right" }}>Price</th>
              <th style={{ padding: "6px 12px" }}>Enriched</th>
              <th style={{ padding: "6px 12px" }}>Link</th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.domain} style={{ borderTop: "1px solid var(--line, #f1ece0)" }}>
                <td style={{ padding: "6px 12px", fontFamily: "monospace", color: "var(--navy)" }}>{d.domain}</td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "var(--navy-2)" }}>
                  {d.quality_score != null ? d.quality_score.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "var(--navy-2)" }}>{fmtPrice(d.price)}</td>
                <td style={{ padding: "6px 12px" }}>{d.enriched ? "✓" : "—"}</td>
                <td style={{ padding: "6px 12px" }}>
                  <a href={forSaleUrl(d.best_price_source || sourceId, d.domain)} target="_blank" rel="noopener noreferrer" className="link-out">
                    for sale ↗
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceRow({ vm }: { vm: RowVM }) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Dom[] | null | "loading">(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const canExpand = !!vm.newCount && vm.newCount > 0;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && list === null) {
      setList("loading");
      try {
        const res = await fetch(`/api/admin/source-domains?source=${encodeURIComponent(vm.sourceId)}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "request failed");
        setOrigin(data.origin ?? null);
        setList((data.domains as Dom[]) ?? []);
      } catch {
        setList(null);
      }
    }
  }

  return (
    <>
      <tr className={vm.dim ? "dim" : undefined}>
        <td>
          <span title={vm.statusLabel} className={`dot dot--${vm.statusKey}`} />
        </td>
        <td className="mono">
          {vm.sourceId}
          {vm.todo && <span className="todo-badge">todo</span>}
        </td>
        <td>
          {canExpand ? (
            <button
              type="button"
              onClick={toggle}
              className="link-out"
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, font: "inherit" }}
              title="Show the names added new today"
            >
              {vm.newCount!.toLocaleString()} {open ? "▾" : "▸"}
            </button>
          ) : (
            vm.newCount ?? "—"
          )}
        </td>
        <td className="muted">{vm.lastRun}</td>
        <td className="muted">
          {vm.scheduleLabel}
          {vm.scheduleVia && (
            <span style={{ color: "var(--navy-3)", marginLeft: 6, fontSize: 12 }}>via {vm.scheduleVia}</span>
          )}
        </td>
        <td><KindPill kind={vm.kind} /></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLS} style={{ padding: "0 12px" }}>
            <NewTodayList list={list} origin={origin} sourceId={vm.sourceId} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function SourceTable({ rows }: { rows: RowVM[] }) {
  return (
    <div className="table-scroll">
      <table className="dash" style={{ tableLayout: "fixed", width: "100%" }}>
        <colgroup>
          <col style={{ width: 30 }} />
          <col style={{ width: "26%" }} />
          <col style={{ width: 120 }} />
          <col style={{ width: 120 }} />
          <col />
          <col style={{ width: 150 }} />
        </colgroup>
        <thead>
          <tr>
            <th></th>
            <th>source_id</th>
            <th>new&nbsp;today</th>
            <th>last run</th>
            <th>schedule (ET)</th>
            <th>kind</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((vm) => (
            <SourceRow key={vm.sourceId} vm={vm} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
