"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { canonicalRegistrar } from "@/lib/registrar/registry";

type SnapSource = "Berserk" | "SNAP" | "Rob";
type SnapName = {
  domain: string;
  source: SnapSource;
  tld: string;
  date_purchased: string | null;
  purchase_price: number | null;
  internal_price: number | null;
  spaceship_price: number | null;
  atom_price: string | null;
  on_marketplace: boolean | null;
  platform: string | null;
  still_owned: string | null;
  sold: boolean;
  sold_for: number | null;
  sale_date: string | null;
  fees: number | null;
  net_sale_price: number | null;
  list_for_sale: string | null;
  snagged_rep: string | null;
  premium: string | null;
  active: string | null;
  notes: string | null;
  also_in: SnapSource[];
  also_spellings: string[];
  on_snagged_marketplace: boolean;
};
type Summary = {
  total: number;
  owned: number;
  sold: number;
  on_marketplace: number;
  total_internal_value: number;
  total_sold_for: number;
  bySource: Record<string, number>;
  generatedAt: string;
};
type Report = { rows: SnapName[]; summary: Summary };

// Quick-pick templates for the bulk-update actions (the 99% cases).
const NS_PRESETS: [string, string][] = [
  ["Spaceship", "launch1.spaceship.net, launch2.spaceship.net"],
  ["Snagged / Cloudflare", "ns1.snagged.com, ns2.snagged.com"],
];
const DNS_PRESETS: { label: string; type: string; host: string; value: string; ttl: string }[] = [
  { label: "Afternic verification", type: "TXT", host: "@", value: "afternic-verification-WU7jP5iV3jvptNS8rbH3MT", ttl: "3600" },
];
type Live = {
  registrar: string | null;
  nameservers: string[];
  ns_provider: string | null;
  afternic: { listed: boolean; price: number | null } | null;
  spaceship_price: number | null;
  spaceship_min_offer: number | null;
  checked_at: string;
};

// Local mirrors of the inventory types (do NOT import the server-only lib into this
// client component — it pulls undici/node:crypto into the browser bundle).
type OwnedAt = { provider: string; label: string; account: string; expires?: string | null; autoRenew?: boolean | null };
type AccountStatus = { provider: string; label: string; account: string; ok: boolean; error?: string | null; count: number; capped?: boolean };
const REG_TO_PID: [RegExp, string][] = [[/spaceship/i, "spaceship"], [/porkbun/i, "porkbun"], [/dynadot/i, "dynadot"], [/namesilo/i, "namesilo"], [/godaddy/i, "godaddy"], [/namecheap/i, "namecheap"]];
const regPid = (r?: string | null): string | null => { const s = String(r || ""); for (const [re, id] of REG_TO_PID) if (re.test(s)) return id; return null; };
const daysUntil = (s?: string | null): number | null => { if (!s) return null; const t = Date.parse(s); return isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000); };
const fmtExp = (s?: string | null): string => { if (!s) return "—"; const t = Date.parse(s); return isNaN(t) ? String(s) : new Date(t).toLocaleDateString(); };

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString()}`);

const SOURCE_STYLE: Record<string, { name: string; bg: string; fg: string }> = {
  Berserk: { name: "Berserk", bg: "#f1e7dc", fg: "#875428" },
  SNAP: { name: "SNAP", bg: "#e2efe5", fg: "#2f7d4f" },
  Rob: { name: "Rob", bg: "#e6e8f5", fg: "#3f4a8f" },
};
function SourcePill({ source }: { source: string }) {
  const s = SOURCE_STYLE[source] || { name: source, bg: "#eee", fg: "#333" };
  return (
    <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600, background: s.bg, color: s.fg, whiteSpace: "nowrap" }}>{s.name}</span>
  );
}

// A live marketplace listing cell: green ✓ + price when listed, grey ✗ when we
// checked and it's not, muted "…/—" when unknown (still resolving / can't tell).
function MarketCell({ listed, price, sub, pending }: { listed: boolean | null; price?: string | null; sub?: string | null; pending?: boolean }) {
  if (pending) return <span style={{ color: "#c8c8d2" }}>…</span>;
  if (listed == null) return <span style={{ color: "#c8c8d2" }}>—</span>;
  if (!listed) return <span style={{ color: "#c2b8b8" }}>✗</span>;
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: "#2f7d4f", fontWeight: 700 }}>✓</span>
      {price && <span style={{ marginLeft: 5, fontSize: 12 }}>{price}</span>}
      {sub && <span style={{ display: "block", fontSize: 10.5, color: "#9a9aac" }}>{sub}</span>}
    </span>
  );
}

const card: CSSProperties = { border: "1px solid #e6e6ef", borderRadius: 12, padding: "14px 16px", background: "#fff" };
const th: CSSProperties = { textAlign: "left", padding: "8px 10px", fontSize: 12, color: "#6b6b7b", fontWeight: 600, borderBottom: "1px solid #e6e6ef", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none" };
const td: CSSProperties = { padding: "8px 10px", fontSize: 13, borderBottom: "1px solid #f0f0f5", verticalAlign: "top" };

type SortKey = "domain" | "source" | "tld" | "date" | "purchase" | "internal" | "registrar" | "nameservers" | "status" | "afternic" | "atom" | "spaceship" | "marketplace";

// localStorage cache for live lookups so repeat views don't re-resolve.
const LIVE_TTL = 24 * 3600 * 1000;
const liveKey = (d: string) => `snapLive:${d}`;
function readLive(d: string): Live | null {
  try {
    const raw = localStorage.getItem(liveKey(d));
    if (!raw) return null;
    const v = JSON.parse(raw) as Live;
    if (!v.checked_at || Date.now() - Date.parse(v.checked_at) > LIVE_TTL) return null;
    return v;
  } catch {
    return null;
  }
}
function writeLive(d: string, v: Live) {
  try {
    localStorage.setItem(liveKey(d), JSON.stringify(v));
  } catch {
    /* ignore quota */
  }
}

type PreviewRow = {
  domain: string;
  registrar: string | null;
  dnsHost?: string | null;
  provider: string | null;
  wired: boolean;
  willChange: boolean;
  noChange: boolean;
  caveat?: string | null;
  skipReason: string | null;
  current?: string[];
  target?: string[] | { type: string; host: string; value: string };
};
type Preview = { dryRun: boolean; action: string; summary: { total: number; willUpdate: number; noChange: number; skipped: number }; results: PreviewRow[] };

export default function SnapNamesClient({ canWrite = false }: { canWrite?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  // ── bulk update (registrar/DNS pushes) ──────────────────────────────────
  const [updateMode, setUpdateMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<"nameservers" | "ns_default" | "dns">("nameservers");
  const [nsTarget, setNsTarget] = useState("");
  const [dnsRec, setDnsRec] = useState({ type: "A", host: "@", value: "", ttl: "3600" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [providers, setProviders] = useState<{ id: string; label: string; wired: boolean }[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ summary: { applied: number; noChange: number; failed: number; skipped: number }; results: { domain: string; ok: boolean; skipped?: boolean; noChange?: boolean; provider: string | null; account?: string | null; error?: string | null }[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [resolving, setResolving] = useState(0); // # domains still pending live lookup
  const liveRef = useRef<Record<string, Live>>({});

  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  // ── registrar-account inventory (verify possession + expiry/auto-renew) ──
  const [invOwned, setInvOwned] = useState<Record<string, OwnedAt>>({});
  const [invAccounts, setInvAccounts] = useState<AccountStatus[]>([]);
  const [invBuiltAt, setInvBuiltAt] = useState<string | null>(null);
  const [invHidden, setInvHidden] = useState<Set<string>>(new Set());
  const [rebuilding, setRebuilding] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [showHiddenAudit, setShowHiddenAudit] = useState(false);

  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"all" | SnapSource>("all");
  const [status, setStatus] = useState<"all" | "owned" | "sold" | "marketplace">("owned");
  const [tldFilter, setTldFilter] = useState<Set<string>>(new Set()); // empty = all
  const [nsFilter, setNsFilter] = useState<Set<string>>(new Set());
  const [regFilter, setRegFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("domain");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  // Load the shared archive overlay (domains hidden from the list by default).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/snap-names/archive", { cache: "no-store" });
        const j = await res.json();
        if (res.ok && Array.isArray(j.archived)) setArchived(new Set(j.archived.map((d: string) => d.toLowerCase())));
      } catch {
        /* fail-open: nothing archived */
      }
    })();
  }, []);

  const toggleArchive = useCallback(async (domain: string, next: boolean) => {
    const d = domain.toLowerCase();
    setArchived((prev) => {
      const s = new Set(prev);
      if (next) s.add(d);
      else s.delete(d);
      return s;
    });
    try {
      const res = await fetch("/api/admin/snap-names/archive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: d, archived: next }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || `HTTP ${res.status}`);
    } catch (e) {
      // revert on failure
      setArchived((prev) => {
        const s = new Set(prev);
        if (next) s.delete(d);
        else s.add(d);
        return s;
      });
      setErr(String((e as Error)?.message || e));
    }
  }, []);

  // Load the cached registrar-account inventory snapshot (fast; fail-open).
  const applyInventory = useCallback((snap: { built_at?: string; accounts?: AccountStatus[]; owned?: Record<string, OwnedAt> } | null, hidden?: string[]) => {
    if (snap) {
      setInvOwned(snap.owned || {});
      setInvAccounts(snap.accounts || []);
      setInvBuiltAt(snap.built_at || null);
    }
    if (Array.isArray(hidden)) setInvHidden(new Set(hidden.map((d) => d.toLowerCase())));
  }, []);
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/snap-names/inventory", { cache: "no-store" });
        const j = await res.json();
        if (res.ok) applyInventory(j.snapshot, j.hidden);
      } catch {
        /* fail-open: no verification data */
      }
    })();
  }, [applyInventory]);

  const rebuildInventory = useCallback(async () => {
    setRebuilding(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/snap-names/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "rebuild" }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      applyInventory(j.snapshot, j.hidden);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setRebuilding(false);
    }
  }, [applyInventory]);

  const toggleAuditHide = useCallback(async (domain: string, next: boolean) => {
    const d = domain.toLowerCase();
    setInvHidden((prev) => { const s = new Set(prev); if (next) s.add(d); else s.delete(d); return s; });
    try {
      const res = await fetch("/api/admin/snap-names/inventory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: next ? "hide" : "unhide", domain: d }) });
      if (!res.ok) throw new Error((await res.json())?.error || `HTTP ${res.status}`);
    } catch (e) {
      setInvHidden((prev) => { const s = new Set(prev); if (next) s.delete(d); else s.add(d); return s; });
      setErr(String((e as Error)?.message || e));
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/snap-names", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setReport(j.report as Report);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // Progressive live registrar/NS resolution: seed from localStorage, then batch
  // the still-unknown domains through /resolve. Fail-open per batch.
  const resolveLive = useCallback(
    async (rows: SnapName[], force = false) => {
      const domains = rows.map((r) => r.domain);
      const seeded: Record<string, Live> = {};
      const todo: string[] = [];
      for (const d of domains) {
        const cached = force ? null : readLive(d);
        if (cached) seeded[d] = cached;
        else todo.push(d);
      }
      if (Object.keys(seeded).length) {
        liveRef.current = { ...liveRef.current, ...seeded };
        setLive({ ...liveRef.current });
      }
      if (!todo.length) return;
      setResolving(todo.length);
      const BATCH = 25;
      for (let i = 0; i < todo.length; i += BATCH) {
        const chunk = todo.slice(i, i + BATCH);
        try {
          const res = await fetch("/api/admin/snap-names/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domains: chunk }),
          });
          const j = await res.json();
          const results = (j?.results || {}) as Record<string, Live>;
          for (const [d, v] of Object.entries(results)) {
            liveRef.current[d] = v;
            // Only PERSIST a result that actually resolved something. A failed lookup
            // (registrar null AND no nameservers) is usually a transient RDAP/DNS
            // rate-limit under batch load — caching it for 24h would freeze a stale
            // blank/"none". Leave it in-memory only so the next load re-resolves.
            if (v.registrar || (v.nameservers && v.nameservers.length)) writeLive(d, v);
          }
          setLive({ ...liveRef.current });
        } catch {
          /* leave this chunk unresolved */
        }
        setResolving((n) => Math.max(0, n - chunk.length));
      }
      setResolving(0);
    },
    []
  );

  useEffect(() => {
    if (report?.rows?.length) resolveLive(report.rows);
  }, [report, resolveLive]);

  // Load provider wiring status when Updates mode opens (so you can see which keys
  // took effect). Cheap booleans-only endpoint.
  useEffect(() => {
    if (!updateMode || !canWrite) return;
    (async () => {
      try {
        const res = await fetch("/api/admin/snap-names/providers", { cache: "no-store" });
        const j = await res.json();
        if (res.ok && Array.isArray(j.providers)) setProviders(j.providers);
      } catch {
        /* ignore */
      }
    })();
  }, [updateMode, canWrite]);

  const tlds = useMemo(() => {
    if (!report) return [];
    const counts = new Map<string, number>();
    for (const r of report.rows) counts.set(r.tld, (counts.get(r.tld) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [report]);

  // NS-provider + registrar options come from the LIVE lookups (resolved
  // progressively), so they fill in as rows resolve.
  const nsProviders = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of Object.values(live)) if (v.ns_provider) counts.set(v.ns_provider, (counts.get(v.ns_provider) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [live]);
  const registrars = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of Object.values(live)) {
      const r = canonicalRegistrar(v.registrar);
      if (r) counts.set(r, (counts.get(r) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [live]);

  // Reconciliation of the SNAP list against the registrar-account inventory.
  const audit = useMemo(() => {
    const okPids = new Set(invAccounts.filter((a) => a.ok).map((a) => a.provider));
    const listPids = new Set(["porkbun", "spaceship", "dynadot", "namesilo", "godaddy", "namecheap"]);
    const reportDomains = new Set((report?.rows || []).map((r) => r.domain.toLowerCase()));
    // In an account, not on our list.
    const untracked = Object.keys(invOwned)
      .filter((d) => !reportDomains.has(d))
      .map((d) => ({ domain: d, at: invOwned[d] }));
    // On our list, not in any account — only when its registrar is one we listed OK
    // (else we can't claim it's missing, just unverifiable).
    const missing = (report?.rows || [])
      .filter((r) => {
        const d = r.domain.toLowerCase();
        if (invOwned[d]) return false;
        const pid = regPid(live[r.domain]?.registrar);
        return !!pid && listPids.has(pid) && okPids.has(pid);
      })
      .map((r) => ({ domain: r.domain, registrar: canonicalRegistrar(live[r.domain]?.registrar) }));
    const hiddenN = (arr: { domain: string }[]) => arr.filter((x) => invHidden.has(x.domain.toLowerCase()));
    const shownN = (arr: { domain: string }[]) => arr.filter((x) => !invHidden.has(x.domain.toLowerCase()));
    return { untracked, missing, okPids, shownN, hiddenN };
  }, [report, invOwned, invAccounts, invHidden, live]);

  const filtered = useMemo(() => {
    if (!report) return [];
    const needle = q.trim().toLowerCase();
    let rows = report.rows.filter((r) => {
      const isArch = archived.has(r.domain);
      if (showArchived ? !isArch : isArch) return false; // default hides archived; toggle shows ONLY archived
      if (src !== "all" && r.source !== src) return false;
      if (status === "owned" && r.sold) return false;
      if (status === "sold" && !r.sold) return false;
      if (status === "marketplace" && !r.on_snagged_marketplace) return false;
      if (tldFilter.size && !tldFilter.has(r.tld)) return false;
      if (nsFilter.size && !nsFilter.has(live[r.domain]?.ns_provider || "")) return false;
      if (regFilter.size && !regFilter.has(canonicalRegistrar(live[r.domain]?.registrar) || "")) return false;
      if (needle) {
        const reg = live[r.domain]?.registrar || "";
        const ns = (live[r.domain]?.nameservers || []).join(" ");
        const hay = `${r.domain} ${r.platform || ""} ${reg} ${ns}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
    const val = (r: SnapName): string | number => {
      switch (sortKey) {
        case "domain": return r.domain;
        case "source": return r.source;
        case "tld": return r.tld;
        case "date": return r.date_purchased ? Date.parse(r.date_purchased) || 0 : 0;
        case "purchase": return r.purchase_price ?? -1;
        case "internal": return r.internal_price ?? -1;
        case "registrar": return (canonicalRegistrar(live[r.domain]?.registrar) || "￿").toLowerCase();
        case "nameservers": return (live[r.domain]?.ns_provider || live[r.domain]?.nameservers?.[0] || "￿").toLowerCase();
        case "status": return r.sold ? 2 : r.on_marketplace ? 1 : 0;
        // Platform columns sort listed-first (with price as the tiebreak); an
        // unresolved live lookup sorts to the bottom (-1).
        case "afternic": {
          const a = live[r.domain]?.afternic;
          return live[r.domain] ? (a ? (a.listed ? (a.price ?? 1) : 0) : -0.5) : -1;
        }
        case "atom": {
          const ns = live[r.domain]?.ns_provider || "";
          return live[r.domain] ? (/atom/i.test(ns) ? 1 : 0) : -1;
        }
        case "spaceship": {
          const l = live[r.domain];
          if (!l) return -1;
          const listed = /spaceship/i.test(l.ns_provider || "");
          return listed ? (l.spaceship_price ?? r.spaceship_price ?? l.spaceship_min_offer ?? 1) : 0;
        }
        case "marketplace": return r.on_snagged_marketplace ? (r.internal_price ?? 1) : 0;
        default: return 0;
      }
    };
    rows = [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * sortDir;
      if (va > vb) return 1 * sortDir;
      return a.domain < b.domain ? -1 : 1;
    });
    return rows;
  }, [report, q, src, status, tldFilter, nsFilter, regFilter, sortKey, sortDir, live, archived, showArchived]);

  const setSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(k);
      setSortDir(k === "domain" || k === "source" || k === "tld" || k === "registrar" || k === "nameservers" ? 1 : -1);
    }
  };
  const arrow = (k: SortKey) => (k === sortKey ? (sortDir === 1 ? " ▲" : " ▼") : "");

  const downloadCsv = () => {
    const cols = ["domain", "source", "also_in", "tld", "date_purchased", "purchase_price", "internal_price", "platform", "registrar", "verified_account", "expires", "auto_renew", "nameservers", "ns_provider", "afternic_listed", "afternic_price", "atom_listed", "atom_price", "spaceship_listed", "spaceship_price", "spaceship_min_offer", "marketplace_listed", "marketplace_price", "on_marketplace", "still_owned", "sold_for", "sale_date", "net_sale_price", "fees", "list_for_sale", "snagged_rep", "premium", "active", "notes"];
    const esc = (v: unknown) => {
      const s = v == null ? "" : Array.isArray(v) ? v.join(" | ") : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of filtered) {
      const l = live[r.domain];
      const ns = l?.ns_provider || "";
      const at = invOwned[r.domain.toLowerCase()];
      const rowObj: Record<string, unknown> = {
        ...r,
        registrar: canonicalRegistrar(l?.registrar) ?? "",
        verified_account: at ? at.label : "",
        expires: at?.expires ? fmtExp(at.expires) : "",
        auto_renew: at ? (at.autoRenew === true ? "yes" : at.autoRenew === false ? "no" : "") : "",
        nameservers: l?.nameservers ?? [],
        ns_provider: l?.ns_provider ?? "",
        afternic_listed: l?.afternic ? (l.afternic.listed ? "yes" : "no") : "",
        afternic_price: l?.afternic?.price ?? "",
        atom_listed: l ? (/atom/i.test(ns) ? "yes" : "no") : "",
        spaceship_listed: l ? (/spaceship/i.test(ns) ? "yes" : "no") : "",
        spaceship_price: l?.spaceship_price ?? (l && /spaceship/i.test(ns) ? r.spaceship_price : "") ?? "",
        spaceship_min_offer: l?.spaceship_min_offer ?? "",
        marketplace_listed: r.on_snagged_marketplace ? "yes" : "no",
        marketplace_price: r.on_snagged_marketplace ? r.internal_price ?? "" : "",
      };
      lines.push(cols.map((c) => esc(rowObj[c])).join(","));
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "snap-names.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const toggleRow = (domain: string) =>
    setSelected((prev) => {
      const s = new Set(prev);
      if (s.has(domain)) s.delete(domain);
      else s.add(domain);
      return s;
    });
  const allShownSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.domain));
  const toggleSelectAll = () =>
    setSelected((prev) => {
      const s = new Set(prev);
      if (allShownSelected) filtered.forEach((r) => s.delete(r.domain));
      else filtered.forEach((r) => s.add(r.domain));
      return s;
    });

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    setPreview(null);
    setApplyResult(null);
    setErr(null);
    try {
      const domains = [...selected];
      const payload =
        bulkAction === "nameservers"
          ? { domains, action: "nameservers", nameservers: nsTarget.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) }
          : bulkAction === "ns_default"
            ? { domains, action: "ns_default" }
            : { domains, action: "dns", record: { type: dnsRec.type, host: dnsRec.host, value: dnsRec.value, ttl: Number(dnsRec.ttl) || 3600 } };
      const res = await fetch("/api/admin/snap-names/bulk-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setPreview(j as Preview);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setPreviewing(false);
    }
  }, [selected, bulkAction, nsTarget, dnsRec]);

  const runApply = useCallback(async () => {
    if (!preview) return;
    const actionLabel = bulkAction === "dns" ? "set a DNS record on" : bulkAction === "ns_default" ? "reset nameservers to registrar default on" : "set nameservers on";
    const n = preview.summary.willUpdate;
    if (!n) return;
    if (!window.confirm(`This will ${actionLabel} ${n} live domain${n === 1 ? "" : "s"} at their registrar — a real, hard-to-reverse change. Continue?`)) return;
    setApplying(true);
    setApplyResult(null);
    setErr(null);
    try {
      const domains = [...selected];
      const payload =
        bulkAction === "nameservers"
          ? { domains, action: "nameservers", nameservers: nsTarget.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean) }
          : bulkAction === "ns_default"
            ? { domains, action: "ns_default" }
            : { domains, action: "dns", record: { type: dnsRec.type, host: dnsRec.host, value: dnsRec.value, ttl: Number(dnsRec.ttl) || 3600 } };
      const res = await fetch("/api/admin/snap-names/bulk-apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.error || `HTTP ${res.status}`);
      setApplyResult(j);
      // Re-resolve the changed domains so the table reflects new nameservers.
      const changed = report?.rows.filter((r) => selected.has(r.domain)) || [];
      if (changed.length) resolveLive(changed, true);
    } catch (e) {
      setErr(String((e as Error)?.message || e));
    } finally {
      setApplying(false);
    }
  }, [preview, bulkAction, selected, nsTarget, dnsRec, report, resolveLive]);

  const s = report?.summary;

  return (
    <main
      // Break out of the app shell's centered .wrap (max-width ~1180px) so the wide
      // table can use the full browser width. left:50% + translateX(-50%) re-centers
      // an element wider than its parent onto the viewport center.
      style={{ position: "relative", left: "50%", transform: "translateX(-50%)", width: "min(1800px, 94vw)", padding: "0 4px" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", margin: 0 }}>SNAP Names</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Every domain we&apos;ve purchased / hold for sale, de-duped to one row each (Berserk wins), with live registrar + nameserver lookups.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {canWrite && (
            <button
              onClick={() => { const entering = !updateMode; setUpdateMode(entering); setPreview(null); setApplyResult(null); if (!entering) setSelected(new Set()); }}
              style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid " + (updateMode ? "#2f2f45" : "#d5d5e0"), background: updateMode ? "#2f2f45" : "#fff", color: updateMode ? "#fff" : "#44445a", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
            >
              {updateMode ? "✕ Exit updates" : "⚙ Updates"}
            </button>
          )}
          <button onClick={downloadCsv} disabled={!filtered.length} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            ⬇ CSV
          </button>
          <button onClick={() => report && resolveLive(report.rows, true)} disabled={!report || resolving > 0} title="Re-resolve registrar + nameservers live" style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            {resolving > 0 ? `Resolving ${resolving}…` : "⟳ Re-resolve live"}
          </button>
          {canWrite && (
            <button onClick={rebuildInventory} disabled={rebuilding} title="Pull the live domain list from every registrar account to verify possession + expiry" style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
              {rebuilding ? "Verifying…" : "✓ Verify accounts"}
            </button>
          )}
          <button onClick={load} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 13 }}>
            {loading ? "Loading…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {err && <div style={{ ...card, marginTop: 16, borderColor: "#f0c0c0", background: "#fdf3f3", color: "#a33" }}>{err}</div>}

      {/* Registrar-account verification: snapshot status + reconciliation audit. */}
      {(invBuiltAt || invAccounts.length > 0) && (
        <div style={{ ...card, marginTop: 12, fontSize: 12.5 }}>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontWeight: 700 }}>Account verification</span>
            {invBuiltAt && <span className="muted">as of {new Date(invBuiltAt).toLocaleString()}</span>}
            {invAccounts.map((a) => (
              <span key={a.label} title={a.error || `${a.count} domains`} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 999, background: a.ok ? "#eef7f0" : "#fbeeee", color: a.ok ? "#2f7d4f" : "#b1442c", fontWeight: 600 }}>
                {a.ok ? "✓" : "✗"} {a.label}{a.ok ? ` · ${a.count}` : ""}{a.capped ? " ⚠" : ""}
              </span>
            ))}
            {(() => {
              const verified = (report?.rows || []).filter((r) => invOwned[r.domain.toLowerCase()]).length;
              const untrackedN = audit.shownN(audit.untracked).length;
              const missingN = audit.shownN(audit.missing).length;
              return (
                <span style={{ marginLeft: "auto", display: "inline-flex", gap: 12, alignItems: "center" }}>
                  <span style={{ color: "#2f7d4f", fontWeight: 700 }}>✓ {verified} verified</span>
                  <span style={{ color: "#a3502f", fontWeight: 700 }}>⚠ {missingN} not in account</span>
                  <span style={{ color: "#3a5a9a", fontWeight: 700 }}>➕ {untrackedN} untracked</span>
                  <button onClick={() => setShowAudit((v) => !v)} style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
                    {showAudit ? "Hide audit ▴" : "Audit ▾"}
                  </button>
                </span>
              );
            })()}
          </div>

          {showAudit && (
            <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {([
                { key: "missing" as const, title: "On our list, not in any account", color: "#a3502f", rows: audit.missing },
                { key: "untracked" as const, title: "In an account, not on our list", color: "#3a5a9a", rows: audit.untracked },
              ]).map((bucket) => {
                const shown = showHiddenAudit ? audit.hiddenN(bucket.rows) : audit.shownN(bucket.rows);
                return (
                  <div key={bucket.key} style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                    <div style={{ fontWeight: 700, color: bucket.color, marginBottom: 6 }}>{bucket.title} <span className="muted">({shown.length})</span></div>
                    <div style={{ maxHeight: 300, overflowY: "auto" }}>
                      {shown.length === 0 && <div className="muted" style={{ fontSize: 12 }}>{showHiddenAudit ? "Nothing hidden." : "Nothing here."}</div>}
                      {shown.map((row) => {
                        const at = "at" in row ? (row as { at: OwnedAt }).at : null;
                        const reg = "registrar" in row ? (row as { registrar: string | null }).registrar : null;
                        const isHidden = invHidden.has(row.domain.toLowerCase());
                        return (
                          <div key={row.domain} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "3px 0", borderBottom: "1px solid #f4f4f8" }}>
                            <span style={{ fontWeight: 600, minWidth: 150 }}>{row.domain}</span>
                            <span className="muted" style={{ fontSize: 11.5, flex: 1 }}>
                              {at ? `${at.label}${at.expires ? ` · exp ${fmtExp(at.expires)}` : ""}${at.autoRenew === false ? " · no auto-renew" : ""}` : reg || ""}
                            </span>
                            <button onClick={() => toggleAuditHide(row.domain, !isHidden)} title={isHidden ? "Un-hide" : "Hide from this audit"} style={{ padding: "2px 8px", borderRadius: 6, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 11 }}>
                              {isHidden ? "un-hide" : "hide"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
                <button onClick={() => setShowHiddenAudit((v) => !v)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 11.5 }}>
                  {showHiddenAudit ? "Show active" : "Show hidden"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginTop: 16 }}>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Unique names</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.total}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Still owned</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.owned}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Sold</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.sold}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>On marketplace</div><div style={{ fontSize: 22, fontWeight: 700 }}>{s.on_marketplace}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Internal value (owned)</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_internal_value)}</div></div>
          <div style={card}><div className="muted" style={{ fontSize: 12 }}>Total sold for</div><div style={{ fontSize: 22, fontWeight: 700 }}>{usd(s.total_sold_for)}</div></div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginTop: 18 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search domain / registrar / NS…" style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13, minWidth: 220 }} />
        <Segmented value={src} onChange={(v) => setSrc(v as typeof src)} options={[["all", "All sources"], ["SNAP", "SNAP"], ["Rob", "Rob"], ["Berserk", "Berserk"]]} />
        <Segmented value={status} onChange={(v) => setStatus(v as typeof status)} options={[["all", "All"], ["owned", "Owned"], ["sold", "Sold"], ["marketplace", "On marketplace"]]} />
        <MultiSelect label="All TLDs" allLabel="All TLDs" options={tlds} selected={tldFilter} onChange={setTldFilter} fmt={(t) => `.${t}`} />
        <MultiSelect label="All nameservers" allLabel="All nameservers" options={nsProviders} selected={nsFilter} onChange={setNsFilter} />
        <MultiSelect label="All registrars" allLabel="All registrars" options={registrars} selected={regFilter} onChange={setRegFilter} />
        <button
          onClick={() => setShowArchived((v) => !v)}
          title="Archived names are hidden from the main list"
          style={{ padding: "7px 12px", borderRadius: 8, border: "1px solid #d5d5e0", background: showArchived ? "#2f2f45" : "#fff", color: showArchived ? "#fff" : "#44445a", cursor: "pointer", fontSize: 12.5, fontWeight: showArchived ? 600 : 500 }}
        >
          {showArchived ? "← Back to active" : `Show archived${archived.size ? ` (${archived.size})` : ""}`}
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: "auto" }}>
          {filtered.length} shown{resolving > 0 ? ` · resolving ${resolving} live…` : ""}
        </span>
      </div>

      {updateMode && (
        <div style={{ ...card, marginTop: 12, background: "#fbfaf7", borderColor: "#e0dccf" }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <strong style={{ fontSize: 13 }}>{selected.size} selected</strong>
            <select value={bulkAction} onChange={(e) => { setBulkAction(e.target.value as "nameservers" | "ns_default" | "dns"); setPreview(null); }} style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }}>
              <option value="nameservers">Set nameservers</option>
              <option value="ns_default">Reset nameservers to registrar default</option>
              <option value="dns">Set a DNS record</option>
            </select>
            {bulkAction === "nameservers" ? (
              <>
                <input value={nsTarget} onChange={(e) => setNsTarget(e.target.value)} placeholder="ns1.example.com, ns2.example.com" style={{ padding: "7px 10px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13, minWidth: 280, flex: "1 1 280px" }} />
                {NS_PRESETS.map(([label, val]) => (
                  <button key={label} type="button" onClick={() => { setNsTarget(val); setPreview(null); }} title={val} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #cdd7cf", background: "#eef3ee", color: "#2f6d47", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                    → {label}
                  </button>
                ))}
              </>
            ) : bulkAction === "ns_default" ? (
              <span className="muted" style={{ fontSize: 12.5, flex: "1 1 auto" }}>Each name is set to <strong>its own registrar&apos;s</strong> default nameservers (Porkbun / Spaceship / Dynadot / NameSilo / Namecheap). GoDaddy is skipped — it assigns a per-domain pair.</span>
            ) : (
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <select value={dnsRec.type} onChange={(e) => setDnsRec({ ...dnsRec, type: e.target.value })} style={{ padding: "7px 8px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }}>
                  {["A", "AAAA", "CNAME", "MX", "TXT", "URL"].map((t) => <option key={t}>{t}</option>)}
                </select>
                <input value={dnsRec.host} onChange={(e) => setDnsRec({ ...dnsRec, host: e.target.value })} placeholder="host (@)" style={{ width: 90, padding: "7px 8px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }} />
                <input value={dnsRec.value} onChange={(e) => setDnsRec({ ...dnsRec, value: e.target.value })} placeholder="value" style={{ minWidth: 200, flex: "1 1 200px", padding: "7px 8px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }} />
                <input value={dnsRec.ttl} onChange={(e) => setDnsRec({ ...dnsRec, ttl: e.target.value })} placeholder="ttl" style={{ width: 70, padding: "7px 8px", borderRadius: 8, border: "1px solid #d5d5e0", fontSize: 13 }} />
                {DNS_PRESETS.map((p) => (
                  <button key={p.label} type="button" onClick={() => { setDnsRec({ type: p.type, host: p.host, value: p.value, ttl: p.ttl }); setPreview(null); }} title={`${p.type} ${p.host} = ${p.value}`} style={{ padding: "6px 10px", borderRadius: 999, border: "1px solid #cdd7cf", background: "#eef3ee", color: "#2f6d47", cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
                    → {p.label}
                  </button>
                ))}
              </span>
            )}
            <button onClick={runPreview} disabled={!selected.size || previewing} style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: "#2f7d4f", color: "#fff", cursor: selected.size ? "pointer" : "default", fontSize: 13, fontWeight: 600, opacity: selected.size ? 1 : 0.5 }}>
              {previewing ? "Previewing…" : "Preview changes"}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
            Preview only — nothing is written to any registrar yet. It shows what would change and which rows would be skipped (registrar not wired / no key). Live writes get enabled per-registrar after we validate.
          </div>
          {providers.length > 0 && (
            <div style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
              <span className="muted">Wiring:</span>
              {providers.map((p) => (
                <span key={p.id} title={p.wired ? "API keys present" : "No API key configured"} style={{ padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: p.wired ? "#e2efe5" : "#f0eeea", color: p.wired ? "#2f7d4f" : "#9a9aac" }}>
                  {p.wired ? "✓" : "✗"} {p.label}
                </span>
              ))}
            </div>
          )}
          {/* PREVIEW — shown only until changes are applied. */}
          {preview && !applyResult && (
            <div style={{ marginTop: 12, borderTop: "1px solid #e6e6ef", paddingTop: 12 }}>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13, fontWeight: 600, alignItems: "center" }}>
                <span style={{ color: "#6b6b7b", fontWeight: 700 }}>Preview</span>
                <span style={{ color: "#2f7d4f" }}>✓ {preview.summary.willUpdate} would update</span>
                {preview.summary.noChange > 0 && <span style={{ color: "#6b6b7b" }}>= {preview.summary.noChange} already match</span>}
                {preview.summary.skipped > 0 && <span style={{ color: "#a3502f" }}>✗ {preview.summary.skipped} skipped</span>}
                {canWrite && preview.summary.willUpdate > 0 && (
                  <button onClick={runApply} disabled={applying} style={{ marginLeft: "auto", padding: "7px 16px", borderRadius: 8, border: "none", background: "#b1442c", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                    {applying ? "Applying…" : `⚡ Apply ${preview.summary.willUpdate} change${preview.summary.willUpdate === 1 ? "" : "s"} (live)`}
                  </button>
                )}
              </div>
              <div style={{ marginTop: 8, maxHeight: 260, overflowY: "auto", fontSize: 12.5 }}>
                {preview.results.map((r) => (
                  <div key={r.domain} style={{ padding: "4px 0", borderBottom: "1px solid #f0f0f5", display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600, minWidth: 160 }}>{r.domain}</span>
                    {!r.wired ? (
                      <span style={{ color: "#a3502f" }}>✗ skipped — {r.skipReason}</span>
                    ) : r.noChange ? (
                      <span style={{ color: "#6b6b7b" }}>= already matches ({r.provider})</span>
                    ) : (
                      <span style={{ color: "#2f7d4f" }}>
                        ✓ via {r.provider}
                        {Array.isArray(r.target) && (
                          <span style={{ color: "#6b6b7b", marginLeft: 6 }}>
                            {(r.current || []).join(", ") || "—"} <span style={{ color: "#2f7d4f" }}>→</span> {(r.target as string[]).join(", ")}
                          </span>
                        )}
                        {r.caveat ? <span style={{ color: "#a3502f", marginLeft: 6 }}>⚠ {r.caveat}</span> : null}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* RESULT — replaces the preview once Apply runs. Shows exactly what happened. */}
          {applyResult && (
            <div style={{ marginTop: 12, borderTop: "1px solid #e6e6ef", paddingTop: 12 }}>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 13, fontWeight: 700, alignItems: "center" }}>
                <span style={{ color: "#6b6b7b" }}>Result</span>
                <span style={{ color: "#2f7d4f" }}>⚡ {applyResult.summary.applied} applied</span>
                {applyResult.summary.noChange > 0 && <span style={{ color: "#6b6b7b" }}>= {applyResult.summary.noChange} no-op</span>}
                {applyResult.summary.failed > 0 && <span style={{ color: "#b1442c" }}>✗ {applyResult.summary.failed} failed</span>}
                {applyResult.summary.skipped > 0 && <span style={{ color: "#a3502f" }}>– {applyResult.summary.skipped} skipped</span>}
                <button onClick={() => { setApplyResult(null); setPreview(null); }} style={{ marginLeft: "auto", padding: "6px 14px", borderRadius: 8, border: "1px solid #d5d5e0", background: "#fff", cursor: "pointer", fontSize: 12.5, fontWeight: 600 }}>
                  Done
                </button>
              </div>
              <div style={{ marginTop: 8, maxHeight: 300, overflowY: "auto", fontSize: 12.5 }}>
                {applyResult.results.map((r) => (
                  <div key={r.domain} style={{ padding: "4px 0", borderBottom: "1px solid #f0f0f5", display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600, minWidth: 160 }}>{r.domain}</span>
                    {r.skipped ? (
                      <span style={{ color: "#a3502f" }}>– skipped — {r.error}</span>
                    ) : !r.ok ? (
                      <span style={{ color: "#b1442c" }}>✗ failed — {r.error}</span>
                    ) : r.noChange ? (
                      <span style={{ color: "#6b6b7b" }}>= no change ({r.provider})</span>
                    ) : (
                      <span style={{ color: "#2f7d4f" }}>✓ applied via {r.provider}{r.account ? ` (${r.account})` : ""}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ ...card, marginTop: 12, padding: 0, overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 1100 }}>
          <thead>
            <tr>
              <th style={{ ...th, cursor: "default", width: 34 }}>
                <input type="checkbox" checked={allShownSelected} onChange={toggleSelectAll} title="Select all shown" />
              </th>
              <th style={th} onClick={() => setSort("domain")}>Domain{arrow("domain")}</th>
              <th style={th} onClick={() => setSort("source")}>Source{arrow("source")}</th>
              <th style={th} onClick={() => setSort("tld")}>TLD{arrow("tld")}</th>
              <th style={th} onClick={() => setSort("registrar")}>Registrar{arrow("registrar")}</th>
              <th style={{ ...th, cursor: "default" }} title="Verified against the actual registrar-account inventory">Verified</th>
              <th style={{ ...th, cursor: "default" }} title="Registrar-reported expiration; red within 30 days">Expires</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("internal")}>Internal{arrow("internal")}</th>
              <th style={th} onClick={() => setSort("afternic")}>Afternic{arrow("afternic")}</th>
              <th style={th} onClick={() => setSort("atom")}>Atom{arrow("atom")}</th>
              <th style={th} onClick={() => setSort("spaceship")}>Spaceship{arrow("spaceship")}</th>
              <th style={th} onClick={() => setSort("marketplace")}>Marketplace{arrow("marketplace")}</th>
              <th style={th} onClick={() => setSort("nameservers")}>Nameservers → points to{arrow("nameservers")}</th>
              <th style={th} onClick={() => setSort("status")}>Status{arrow("status")}</th>
              <th style={th} onClick={() => setSort("date")}>Purchased{arrow("date")}</th>
              <th style={{ ...th, textAlign: "right" }} onClick={() => setSort("purchase")}>Cost{arrow("purchase")}</th>
              <th style={{ ...th, cursor: "default" }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const l = live[r.domain];
              const ns = l?.ns_provider || "";
              const pend = !l;
              // Atom / Spaceship / Marketplace "listed" derive from where the NS point
              // (that's what serves the lander); Afternic is an independent live scrape.
              const atomListed = l ? /atom/i.test(ns) : null;
              const shipListed = l ? /spaceship/i.test(ns) : null;
              // Marketplace is the authoritative snagged.com/marketplace scrape
              // (known at load — not dependent on the live NS lookup).
              const mktListed = r.on_snagged_marketplace;
              // Only show a price we LIVE-SCRAPED from the platform itself. Spaceship's
              // buy-now / min-offer come off its lander; if we couldn't read one, show a
              // bare ✓ rather than falling back to the sheet's intended price.
              const shipPrice = l?.spaceship_price ?? null;
              const shipSub = !l?.spaceship_price && l?.spaceship_min_offer ? `min ${usd(l.spaceship_min_offer)}` : null;
              return (
                <tr key={`${r.domain}-${i}`} style={selected.has(r.domain) ? { background: "#f2f7f4" } : undefined}>
                  <td style={{ ...td, textAlign: "center" }}>
                    <input type="checkbox" checked={selected.has(r.domain)} onChange={() => toggleRow(r.domain)} />
                  </td>
                  <td style={{ ...td, fontWeight: 600 }} title={[r.notes, r.also_spellings?.length ? `also spelled: ${r.also_spellings.join(", ")}` : ""].filter(Boolean).join(" · ") || undefined}>
                    {r.domain}
                    {r.also_spellings?.length ? <span style={{ marginLeft: 5, fontSize: 11, color: "#b98a3a", cursor: "help" }} title={`typo variant folded in: ${r.also_spellings.join(", ")}`}>±</span> : null}
                  </td>
                  <td style={td}><SourcePill source={r.source} /></td>
                  <td style={{ ...td, color: "#6b6b7b" }}>.{r.tld}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{l ? canonicalRegistrar(l.registrar) || <span style={{ color: "#b8b8c4" }}>—</span> : <span style={{ color: "#c8c8d2" }}>…</span>}</td>
                  {(() => {
                    const at = invOwned[r.domain.toLowerCase()];
                    const covered = !!regPid(l?.registrar) && audit.okPids.has(regPid(l?.registrar) as string);
                    const dLeft = daysUntil(at?.expires);
                    return (
                      <>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {at ? (
                            <span style={{ color: "#2f7d4f", fontWeight: 600 }} title={`Found in ${at.label}`}>✓ {at.account || at.label}</span>
                          ) : !invBuiltAt ? (
                            <span style={{ color: "#c8c8d2" }}>—</span>
                          ) : covered ? (
                            <span style={{ color: "#a3502f", fontWeight: 600 }} title="Not found in the registrar account we listed">⚠ not found</span>
                          ) : (
                            <span style={{ color: "#b8b8c4" }} title="Registrar not in our verified accounts">—</span>
                          )}
                        </td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>
                          {at?.expires ? (
                            <span style={{ color: dLeft != null && dLeft <= 30 ? "#c0392b" : "#44445a", fontWeight: dLeft != null && dLeft <= 30 ? 700 : 400 }} title={dLeft != null ? `${dLeft} days` : undefined}>
                              {fmtExp(at.expires)}
                              {at.autoRenew === true && <span title="auto-renew on" style={{ marginLeft: 4, color: "#2f7d4f" }}>↻</span>}
                              {at.autoRenew === false && <span title="auto-renew OFF" style={{ marginLeft: 4, color: "#c0392b" }}>⊘</span>}
                            </span>
                          ) : (
                            <span style={{ color: "#c8c8d2" }}>—</span>
                          )}
                        </td>
                      </>
                    );
                  })()}
                  <td style={{ ...td, textAlign: "right", fontWeight: 600 }}>{usd(r.internal_price)}</td>
                  {/* Afternic + Spaceship prices are live-scraped → show them. Atom +
                      Marketplace are NOT scraped for price → bare ✓ only (no inferred figure). */}
                  <td style={td}><MarketCell pending={pend} listed={l?.afternic ? l.afternic.listed : null} price={l?.afternic?.price ? usd(l.afternic.price) : null} /></td>
                  <td style={td}><MarketCell pending={pend} listed={atomListed} /></td>
                  <td style={td}><MarketCell pending={pend} listed={shipListed} price={shipPrice != null ? usd(shipPrice) : null} sub={shipSub} /></td>
                  <td style={td}><MarketCell listed={mktListed} /></td>
                  <td style={td}>
                    {l ? (
                      l.nameservers.length ? (
                        <span>
                          {l.ns_provider && <span style={{ fontWeight: 600, color: "#3f4a8f" }}>{l.ns_provider}</span>}
                          <span title={l.nameservers.join("\n")} style={{ display: "block", fontSize: 11, color: "#9a9aac", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {l.nameservers.join(", ")}
                          </span>
                        </span>
                      ) : (
                        <span style={{ color: "#b8b8c4" }}>none</span>
                      )
                    ) : (
                      <span style={{ color: "#c8c8d2" }}>…</span>
                    )}
                  </td>
                  <td style={td}>
                    {r.sold ? (
                      <span style={{ color: "#2f7d4f", fontWeight: 600 }}>
                        Sold {r.sold_for ? usd(r.sold_for) : ""}
                        {r.sale_date && <span style={{ display: "block", fontSize: 11, color: "#8a8a98", fontWeight: 400 }}>{r.sale_date}</span>}
                      </span>
                    ) : r.on_marketplace ? (
                      <span style={{ color: "#875428" }}>Marketplace</span>
                    ) : (
                      <span style={{ color: "#6b6b7b" }}>Owned</span>
                    )}
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: "#6b6b7b" }}>{r.date_purchased || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>{usd(r.purchase_price)}</td>
                  <td style={{ ...td, textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      onClick={() => toggleArchive(r.domain, !archived.has(r.domain))}
                      title={archived.has(r.domain) ? "Restore to the active list" : "Archive — hide from the list"}
                      style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 15, opacity: 0.5, padding: "0 2px" }}
                    >
                      {archived.has(r.domain) ? "↩" : "📥"}
                    </button>
                  </td>
                </tr>
              );
            })}
            {!loading && !filtered.length && <tr><td style={{ ...td, textAlign: "center", color: "#6b6b7b" }} colSpan={17}>{showArchived ? "No archived names." : "No names match."}</td></tr>}
          </tbody>
        </table>
      </div>
      {s && <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>Generated {new Date(s.generatedAt).toLocaleString()} · A price is shown only where we scrape it live from the platform (Afternic buy-now, Spaceship buy-now/min-offer). Marketplace (snagged.com/marketplace scrape) and Atom (nameserver-derived) show a ✓ only — no inferred price. Registrar/nameservers cached 24h in your browser.</p>}
    </main>
  );
}

// A compact checkbox dropdown for selecting several values (empty = all).
function MultiSelect({
  label,
  allLabel,
  options,
  selected,
  onChange,
  fmt,
}: {
  label: string;
  allLabel: string;
  options: string[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  fmt?: (v: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const summary = selected.size === 0 ? allLabel : selected.size === 1 ? (fmt ? fmt([...selected][0]) : [...selected][0]) : `${label} · ${selected.size}`;
  const toggle = (v: string) => {
    const s = new Set(selected);
    if (s.has(v)) s.delete(v);
    else s.add(v);
    onChange(s);
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #d5d5e0", background: selected.size ? "#eef2ee" : "#fff", color: "#44445a", cursor: "pointer", fontSize: 13, maxWidth: 220, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {summary} ▾
      </button>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20, background: "#fff", border: "1px solid #d5d5e0", borderRadius: 8, boxShadow: "0 8px 24px rgba(0,0,0,.12)", minWidth: 200, maxHeight: 320, overflowY: "auto", padding: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 8px", borderBottom: "1px solid #f0f0f5", marginBottom: 4 }}>
            <button onClick={() => onChange(new Set())} style={{ border: "none", background: "none", color: "#3f4a8f", cursor: "pointer", fontSize: 12 }}>Clear</button>
            <span className="muted" style={{ fontSize: 11 }}>{selected.size || "all"} selected</span>
          </div>
          {options.length === 0 && <div className="muted" style={{ fontSize: 12, padding: "6px 8px" }}>Resolving…</div>}
          {options.map((o) => (
            <label key={o} style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 8px", fontSize: 13, cursor: "pointer", borderRadius: 6 }}>
              <input type="checkbox" checked={selected.has(o)} onChange={() => toggle(o)} />
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{fmt ? fmt(o) : o}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Segmented({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid #d5d5e0", borderRadius: 8, overflow: "hidden" }}>
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} style={{ padding: "7px 12px", border: "none", borderLeft: options[0][0] === v ? "none" : "1px solid #ececf2", background: value === v ? "#2f2f45" : "#fff", color: value === v ? "#fff" : "#44445a", cursor: "pointer", fontSize: 12.5, fontWeight: value === v ? 600 : 500 }}>
          {label}
        </button>
      ))}
    </div>
  );
}
