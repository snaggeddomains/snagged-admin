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
  product: string;
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
  link?: string | null;
};

type Auc = {
  domain: string;
  price: number | null;
  endTimeUtc: string | null;
  bidCount: number | null;
  link: string | null;
};

const COLS = 6;

// "ends in 3h 12m" from an ISO end time — auction rows show time-left, not a date.
function fmtEnds(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const ms = t - Date.now();
  if (ms <= 0) return "ended";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Best-effort link to where the domain is listed for sale, by marketplace.
// Falls back to the domain's own URL (parked/for-sale landers usually live there).
function forSaleUrl(source: string | null, domain: string): string {
  const s = (source || "").toLowerCase();
  const label = domain.split(".")[0];
  const d = encodeURIComponent(domain);
  if (s.includes("afternic")) return `https://www.afternic.com/domain/${domain}`;
  // Atom listing pages are /name/<Domain> on the FULL domain with the SLD's
  // first letter capitalized (e.g. ballroom.ai -> /name/Ballroom.ai).
  if (s.includes("atom")) return `https://www.atom.com/name/${domain.charAt(0).toUpperCase()}${domain.slice(1)}`;
  if (s.includes("sedo")) return `https://sedo.com/search/?keyword=${d}`;
  if (s.includes("dan")) return `https://dan.com/buy-domain/${domain}`;
  if (s.includes("dropcatch")) return `https://www.dropcatch.com/domain/${domain}`;
  if (s.includes("namejet")) return `https://www.namejet.com/Pages/Auctions/BackorderDetails.aspx?domainname=${d}`;
  if (s.includes("godaddy")) return `https://www.godaddy.com/domainsearch/find?domainToCheck=${d}`;
  if (s.includes("namecheap")) return `https://www.namecheap.com/market/?term=${d}`;
  if (s.includes("brandbucket")) return `https://www.brandbucket.com/search?search=${encodeURIComponent(label)}`;
  if (s.includes("oxley")) return `https://oxley.io/domain/${domain}`;
  // NamePros: the per-listing thread URL is normally carried on the row (d.link);
  // this is only the fallback for a domain without one — land on NamePros, not the bare domain.
  if (s.includes("namepros")) return `https://www.namepros.com/search/?q=${d}&o=date`;
  // Reddit r/Domains: the post permalink is normally on the row (d.link); fallback to a sub search.
  if (s.includes("reddit")) return `https://www.reddit.com/r/Domains/search/?q=${d}&restrict_sr=1`;
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
      <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--navy-3)", background: "var(--cream-2, #fbf7ec)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Domain</th>
              <th style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>Quality</th>
              <th style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>Price</th>
              <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Enriched</th>
              <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Link</th>
              <th style={{ width: "100%" }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.domain} style={{ borderTop: "1px solid var(--line, #f1ece0)" }}>
                <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--navy)", whiteSpace: "nowrap" }}>{d.domain}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--navy-2)", whiteSpace: "nowrap" }}>
                  {d.quality_score != null ? d.quality_score.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--navy-2)", whiteSpace: "nowrap" }}>{fmtPrice(d.price)}</td>
                <td style={{ padding: "6px 10px" }}>{d.enriched ? "✓" : "—"}</td>
                <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                  <a href={d.link || forSaleUrl(d.best_price_source || sourceId, d.domain)} target="_blank" rel="noopener noreferrer" className="link-out">
                    for sale ↗
                  </a>
                </td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Auction sources: the current LIVE auctions from snapshot.json. These names
// never enter the universe, so there's no quality/enrichment — show the auction
// facts (price, time-left, link to bid) instead.
function AuctionList({ list, sourceId }: { list: Auc[] | null | "loading"; sourceId: string }) {
  if (list === "loading")
    return <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>loading auctions…</div>;
  if (list === null)
    return <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>couldn’t load auctions.</div>;
  if (!list.length)
    return <div className="muted" style={{ fontSize: 12.5, padding: "10px 12px" }}>no live auctions right now.</div>;
  return (
    <div style={{ border: "1px solid var(--line, #e3ddcf)", borderRadius: 10, overflow: "hidden", margin: "4px 0 8px" }}>
      <div style={{ maxHeight: 320, overflowY: "auto", overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--navy-3)", background: "var(--cream-2, #fbf7ec)", position: "sticky", top: 0 }}>
              <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Domain</th>
              <th style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>Price</th>
              <th style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>Bids</th>
              <th style={{ padding: "6px 10px", textAlign: "right", whiteSpace: "nowrap" }}>Ends</th>
              <th style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>Link</th>
              <th style={{ width: "100%" }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.domain} style={{ borderTop: "1px solid var(--line, #f1ece0)" }}>
                <td style={{ padding: "6px 10px", fontFamily: "monospace", color: "var(--navy)", whiteSpace: "nowrap" }}>{a.domain}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--navy-2)", whiteSpace: "nowrap" }}>{fmtPrice(a.price)}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--navy-2)", whiteSpace: "nowrap" }}>{a.bidCount ?? "—"}</td>
                <td style={{ padding: "6px 10px", textAlign: "right", color: "var(--navy-2)", whiteSpace: "nowrap" }}>{fmtEnds(a.endTimeUtc)}</td>
                <td style={{ padding: "6px 10px", whiteSpace: "nowrap" }}>
                  <a href={a.link || forSaleUrl(sourceId, a.domain)} target="_blank" rel="noopener noreferrer" className="link-out">
                    auction ↗
                  </a>
                </td>
                <td></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SourceRow({ vm }: { vm: RowVM }) {
  const isAuction = vm.product === "auctions";
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Dom[] | null | "loading">(null);
  const [aucs, setAucs] = useState<Auc[] | null | "loading">(null);
  const [origin, setOrigin] = useState<string | null>(null);
  const canExpand = !!vm.newCount && vm.newCount > 0;

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && (isAuction ? aucs === null : list === null)) {
      if (isAuction) setAucs("loading"); else setList("loading");
      try {
        const qs = isAuction ? "&kind=auctions" : "";
        const res = await fetch(`/api/admin/source-domains?source=${encodeURIComponent(vm.sourceId)}${qs}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "request failed");
        if (isAuction) {
          setAucs((data.auctions as Auc[]) ?? []);
        } else {
          setOrigin(data.origin ?? null);
          setList((data.domains as Dom[]) ?? []);
        }
      } catch {
        if (isAuction) setAucs(null); else setList(null);
      }
    }
  }

  return (
    <>
      <tr className={vm.dim ? "dim" : undefined}>
        <td>
          <span title={vm.statusLabel} className={`dot dot--${vm.statusKey}`} />
        </td>
        <td className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={vm.sourceId}>
          {vm.sourceId}
          {vm.todo && <span className="todo-badge">todo</span>}
        </td>
        <td>
          {canExpand ? (
            <button
              type="button"
              onClick={toggle}
              className="link-out"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 6px", font: "inherit", display: "inline-flex", alignItems: "center", gap: 6 }}
              title={isAuction ? "Show the current live auctions" : "Show the names added new today"}
            >
              <span style={{ display: "inline-block", minWidth: "2.5ch", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 14 }}>{vm.newCount!.toLocaleString()}</span>
              <span style={{ fontSize: 17 }}>{open ? "▾" : "▸"}</span>
            </button>
          ) : (
            <span style={{ display: "inline-block", padding: "2px 6px" }}>
              <span style={{ display: "inline-block", minWidth: "2.5ch", textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 14 }}>{vm.newCount ?? "—"}</span>
            </span>
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
            {isAuction ? (
              <AuctionList list={aucs} sourceId={vm.sourceId} />
            ) : (
              <NewTodayList list={list} origin={origin} sourceId={vm.sourceId} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function SourceTable({ rows, countHeader = "new today" }: { rows: RowVM[]; countHeader?: string }) {
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
            <th style={{ whiteSpace: "nowrap" }}>{countHeader}</th>
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
