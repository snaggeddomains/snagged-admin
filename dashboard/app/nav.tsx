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
    <nav
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid #e5e7eb",
        marginBottom: 24,
      }}
    >
      {TABS.map((t) => {
        const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            style={{
              padding: "10px 14px",
              fontSize: 14,
              color: active ? "#111" : "#6b7280",
              textDecoration: "none",
              borderBottom: active ? "2px solid #111" : "2px solid transparent",
              marginBottom: -1,
              fontWeight: active ? 600 : 400,
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
