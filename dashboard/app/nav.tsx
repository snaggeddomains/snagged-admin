"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Admin module sections. Cross-module switching (Research/Admin) lives in the
// global TopBar; this is just the admin sub-nav.
const TABS = [
  { href: "/admin", label: "Sources" },
  { href: "/admin/config", label: "Configuration" },
  { href: "/admin/schedule", label: "Schedule" },
  { href: "/admin/users", label: "Users" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="tab-nav">
      {TABS.map((t) => {
        const active =
          t.href === "/admin" ? pathname === "/admin" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : ""}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
