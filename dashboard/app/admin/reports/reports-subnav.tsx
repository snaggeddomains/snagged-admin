"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// In-page sub-nav for the Reports section: switches between the API cost report
// and Site Analytics. Only the links the user can actually open are shown (perms
// resolved server-side and passed in). Mirrors the .tab-nav look at a smaller scale.
export default function ReportsSubnav({ canCost, canAnalytics }: { canCost: boolean; canAnalytics: boolean }) {
  const pathname = usePathname();
  const items = [
    { href: "/admin/reports", label: "API cost & usage", show: canCost },
    { href: "/admin/reports/analytics", label: "Site analytics", show: canAnalytics },
  ].filter((i) => i.show);
  if (items.length < 2) return null; // nothing to switch between

  return (
    <nav style={{ display: "inline-flex", gap: 4, border: "1px solid #e3ddcf", borderRadius: 8, padding: 3, marginBottom: 16 }}>
      {items.map((i) => {
        const active = i.href === "/admin/reports" ? pathname === "/admin/reports" : pathname.startsWith(i.href);
        return (
          <Link
            key={i.href}
            href={i.href}
            style={{
              padding: "5px 12px", fontSize: 13, fontWeight: 700, borderRadius: 6, textDecoration: "none",
              background: active ? "var(--navy, #254254)" : "transparent",
              color: active ? "#fff" : "var(--navy, #254254)",
            }}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
