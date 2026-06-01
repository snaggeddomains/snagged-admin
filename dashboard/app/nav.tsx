"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin module sections. Cross-module switching (Research/Admin) lives in the
// global TopBar; this is just the admin sub-nav.
export const TABS = [
  { href: "/admin", label: "Sources" },
  { href: "/admin/config", label: "Configuration" },
  { href: "/admin/schedule", label: "Schedule" },
  { href: "/admin/users", label: "Users" },
  // Playbook Lessons curation is admin-only; it lives in the research SPA but is
  // surfaced here so it's an Admin function. Opens the research /research/admin view.
  { href: "/research/admin", label: "Lessons" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="tab-nav">
      {TABS.map((t) => {
        const active =
          t.href === "/admin" ? pathname === "/admin" : pathname.startsWith(t.href);
        // /research/* is the separate research app (reached via rewrite) — use a
        // plain anchor so it does a full navigation rather than a client-side
        // RSC fetch that would 404.
        if (t.href.startsWith("/research")) {
          return (
            <a key={t.href} href={t.href} className={active ? "active" : ""}>
              {t.label}
            </a>
          );
        }
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : ""}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
