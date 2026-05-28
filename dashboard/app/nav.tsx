"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Sources" },
  { href: "/config", label: "Configuration" },
  { href: "/schedule", label: "Schedule" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="tab-nav">
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} className={active ? "active" : ""}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
