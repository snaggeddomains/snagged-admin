"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Tab = { href: string; label: string };
type Group = { label: string; tabs: Tab[] };

// Index routes ("/admin", "/reports", "/deals") match exactly so a child route
// ("/reports/cost", "/deals/tasks") doesn't also light up the parent tab. Without this,
// Board ("/deals") lit up alongside My Tasks ("/deals/tasks") since it's a prefix.
function isActive(pathname: string, href: string): boolean {
  const isIndex = href === "/admin" || href === "/reports" || href === "/deals";
  return isIndex ? pathname === href : pathname.startsWith(href);
}

// A single tab link. /research/* is the separate research app (reached via a rewrite) — use a
// plain anchor so it does a full navigation rather than a client-side RSC fetch that would 404.
function TabLink({ href, label, active, className, onClick }: Tab & { active: boolean; className?: string; onClick?: () => void }) {
  const cls = (className ? className + " " : "") + (active ? "active" : "");
  return href.startsWith("/research")
    ? <a href={href} className={cls} onClick={onClick}>{label}</a>
    : <Link href={href} className={cls} onClick={onClick}>{label}</Link>;
}

// Admin sub-nav. Tabs are filtered to what the user can access (in the layout / SectionChrome).
// When `groups` is passed (the Tools section), the sub-nav is a 3rd tier: each named group is a
// small dropdown of its pages; otherwise a flat tab row (every other section).
export default function Nav({ tabs, groups }: { tabs?: Tab[]; groups?: Group[] }) {
  const pathname = usePathname();
  if (groups && groups.length) {
    return (
      <nav className="tab-nav">
        {groups.map((g) => <NavGroup key={g.label} group={g} pathname={pathname || ""} />)}
      </nav>
    );
  }
  return (
    <nav className="tab-nav">
      {(tabs || []).map((t) => (
        <TabLink key={t.href} href={t.href} label={t.label} active={isActive(pathname || "", t.href)} />
      ))}
    </nav>
  );
}

function NavGroup({ group, pathname }: { group: Group; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const active = group.tabs.some((t) => isActive(pathname, t.href));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        className={"tab-nav-group" + (active ? " active" : "")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {group.label}&nbsp;▾
      </button>
      {open && (
        <span
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, minWidth: 190, zIndex: 60,
            background: "var(--cream-2, #fff)", border: "1px solid var(--line, #e3ddcf)", borderRadius: 10,
            boxShadow: "0 10px 30px rgba(37,66,84,.18)", padding: 6, display: "flex", flexDirection: "column", gap: 2,
          }}
        >
          {group.tabs.map((t) => (
            <TabLink
              key={t.href}
              href={t.href}
              label={t.label}
              active={isActive(pathname, t.href)}
              className="tab-nav-item"
              onClick={() => setOpen(false)}
            />
          ))}
        </span>
      )}
    </span>
  );
}
