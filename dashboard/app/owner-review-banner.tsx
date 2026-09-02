"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

// A slim per-user prompt shown across the module chrome (Admin/Deals/Reports/SNAP) when the
// current reviewer has PENDING Owner Review cards assigned to them — "confirm who we bought
// these names from." Self-fetches its own count (best-effort, silent on any error / when the
// queue isn't set up). Hidden on the Owner Review page itself (you're already there).
export default function OwnerReviewBanner() {
  const pathname = usePathname() || "";
  const [n, setN] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/deals/owner-review?status=pending&scope=mine", { cache: "no-store" });
        if (!res.ok) return;
        const j = await res.json();
        if (!dead && typeof j?.myPending === "number") setN(j.myPending);
      } catch { /* silent */ }
    })();
    return () => { dead = true; };
  }, [pathname]);

  if (!n || dismissed || pathname.startsWith("/deals/owner-review")) return null;
  return (
    <div style={{ background: "#fef3ec", border: "1px solid #f3d3c4", borderRadius: 10, padding: "10px 16px", margin: "12px 16px 20px", display: "flex", alignItems: "center", gap: 10, fontSize: 13, flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700, color: "var(--coral,#e2674a)" }}>👤 Owner Review</span>
      <span style={{ color: "var(--navy-2,#4a5b66)" }}>You have <strong>{n}</strong> owner{n === 1 ? "" : "s"} to confirm from recent acquisitions.</span>
      <a href="/deals/owner-review" style={{ marginLeft: "auto", fontWeight: 700, color: "var(--coral,#e2674a)" }}>Review now →</a>
      <button onClick={() => setDismissed(true)} aria-label="Dismiss" style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--muted,#8a94a0)", fontSize: 16, lineHeight: 1, padding: "0 2px" }}>×</button>
    </div>
  );
}
