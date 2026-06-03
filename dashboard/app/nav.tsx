"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin sub-nav. The tabs are filtered to what the user can access in the
// layout (per-tab permissions) and passed in. Cross-module switching
// (Research/Admin) lives in the global TopBar.
export default function Nav({ tabs }: { tabs: { href: string; label: string }[] }) {
  const pathname = usePathname();
  return (
    <nav className="tab-nav">
      {tabs.map((t) => {
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
