"use client";

// Universal ⌘K / Ctrl-K command palette for the admin app (Admin / SNAP / Reports / Deals /
// Research). Mirrors the research SPA's palette: a fuzzy-ranked jump to any destination the
// user can reach. Built from the gated navigation registry (visibleSections × sectionTabs), so
// it always matches the user's permissions and stays in sync as tabs change. Cross-app
// /research/* links full-nav; same-app routes use the client router (no full reload).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { type AppUser, isGranted } from "@/lib/permissions";
import { visibleSections, sectionTabs } from "@/lib/navigation";

type Dest = { label: string; href: string };

// Destinations that are NOT section tabs (so the registry-driven list above can't include them):
// the universal Feedback page + a few research tools that live in the research SPA but aren't in
// RESEARCH_TABS. Kept here so ⌘K reaches EVERYTHING from the admin app too. Gated per perm; Feedback
// is universal. STANDING RULE: any new module/submodule must be reachable here — put it in a nav tab
// array (auto-covered) or add it below if it's a standalone/universal page.
function extraDests(user: AppUser): Dest[] {
  const has = (k: string) => user.is_admin || isGranted(user.permissions, k);
  const out: Dest[] = [{ label: "Feedback & feature requests", href: "/feedback" }]; // universal
  if (has("domain_owner") || has("evaluate")) out.push({ label: "Research · TLD Count", href: "/research/tld-count" });
  if (has("evaluate") || has("domain_owner")) out.push({ label: "Research · Renewal Price", href: "/research/renewal" });
  if (has("person")) out.push({ label: "Research · Net Worth", href: "/research/networth" });
  return out;
}

// exact-prefix > word-prefix > substring > subsequence (matches the research palette).
function score(label: string, q: string): number {
  if (!q) return 1;
  const l = label.toLowerCase();
  if (l.startsWith(q)) return 100;
  if (l.split(/[\s/&·-]+/).some((w) => w.startsWith(q))) return 80;
  const idx = l.indexOf(q);
  if (idx >= 0) return 50 - Math.min(idx, 40);
  let i = 0;
  for (const ch of l) { if (ch === q[i]) i += 1; if (i === q.length) break; }
  return i === q.length ? 12 : -1;
}

export default function CommandPalette({ user }: { user: AppUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Every destination the user can reach: each visible section's home + its gated tabs.
  const dests = useMemo<Dest[]>(() => {
    const out: Dest[] = [];
    const seen = new Set<string>();
    for (const s of visibleSections(user)) {
      const add = (label: string, href: string) => { if (!seen.has(href)) { seen.add(href); out.push({ label, href }); } };
      add(s.label, s.href);
      for (const t of sectionTabs(user, s.key)) add(`${s.label} · ${t.label}`, t.href);
    }
    for (const e of extraDests(user)) if (!seen.has(e.href)) { seen.add(e.href); out.push(e); }
    return out;
  }, [user]);

  const view = useMemo<Dest[]>(() => {
    const query = q.trim().toLowerCase();
    if (!query) return dests;
    return dests
      .map((d) => ({ d, s: score(d.label, query) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.d);
  }, [dests, q]);

  const go = useCallback((d: Dest | undefined) => {
    if (!d) return;
    setOpen(false);
    // /research/* is the separate SPA → full nav; everything else is a client route.
    if (d.href.startsWith("/research")) {
      // Same-origin one-shot flag: the research SPA's boot handler focuses its lookup field on
      // arrival (its own in-SPA focus can't survive this full-page reload).
      try { sessionStorage.setItem("cmdkFocus", "1"); } catch { /* ignore */ }
      window.location.assign(d.href);
    } else router.push(d.href);
  }, [router]);

  // Global ⌘K / Ctrl-K toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);
  useEffect(() => { if (idx > view.length - 1) setIdx(Math.max(0, view.length - 1)); }, [view, idx]);

  if (!open) return null;

  const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(20,25,30,0.45)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 3000, padding: "12vh 16px 16px" };
  const panel: CSSProperties = { background: "var(--paper,#fff)", borderRadius: 14, width: "min(560px,100%)", maxHeight: "70vh", overflow: "hidden", boxShadow: "0 18px 50px rgba(20,25,30,0.3)", display: "flex", flexDirection: "column" };
  const input: CSSProperties = { border: "none", outline: "none", padding: "16px 18px", fontSize: 16, background: "transparent", color: "var(--navy,#254254)", borderBottom: "1px solid var(--line,#e3ddcf)" };
  const item = (active: boolean): CSSProperties => ({ padding: "10px 16px", fontSize: 14, fontWeight: 600, cursor: "pointer", color: "var(--navy,#254254)", background: active ? "var(--cream-2,#f3efe5)" : "transparent" });

  return (
    <div style={overlay} onClick={() => setOpen(false)}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          style={input}
          placeholder="Search sections & tools…"
          value={q}
          autoComplete="off"
          onChange={(e) => { setQ(e.target.value); setIdx(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(view.length - 1, i + 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
            else if (e.key === "Enter") { e.preventDefault(); go(view[idx]); }
          }}
        />
        <div style={{ overflowY: "auto" }}>
          {view.length ? view.map((d, i) => (
            <div key={d.href} style={item(i === idx)} onMouseEnter={() => setIdx(i)} onMouseDown={(e) => { e.preventDefault(); go(d); }}>{d.label}</div>
          )) : <div style={{ ...item(false), color: "var(--navy-3,#8a94a0)", fontWeight: 500, cursor: "default" }}>No matches</div>}
        </div>
        <div style={{ padding: "8px 16px", fontSize: 12, color: "var(--navy-3,#8a94a0)", borderTop: "1px solid var(--line,#e3ddcf)" }}>↑↓ to move · Enter to open · Esc to close</div>
      </div>
    </div>
  );
}
