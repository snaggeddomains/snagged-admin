"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Sources" },
  { href: "/admin/config", label: "Configuration" },
  { href: "/admin/schedule", label: "Schedule" },
  { href: "/admin/users", label: "Users" },
];

export default function Nav({
  canResearch = false,
  researchHref = "/research",
}: {
  canResearch?: boolean;
  researchHref?: string;
}) {
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
      {canResearch && (
        // Cross-module link. Points at the research deployment for now; becomes
        // an in-umbrella /research path once Phase 3 (proxy nesting) lands.
        <a href={researchHref}>Research ↗</a>
      )}
    </nav>
  );
}
