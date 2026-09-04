// Nav destinations as DATA — the single source the research app's ⌘K palette fetches so it never
// drifts from admin's real menus again. Returns visibleSections(user) × sectionTabs(user),
// permission-filtered for the logged-in user, so the research palette shows exactly the admin/SNAP/
// Deals/Tools pages this user can actually open. Same-origin (app.snagged.com) → the session cookie
// authenticates the cross-app fetch automatically. The research section is excluded (research's own
// palette already covers its tools via a DOM scan).

import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { visibleSections, sectionTabs } from "@/lib/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ destinations: [] });
  const destinations: { section: string; label: string; href: string }[] = [];
  for (const s of visibleSections(me)) {
    if (s.key === "research") continue; // research app owns its own palette entries (DOM-scanned)
    for (const t of sectionTabs(me, s.key)) {
      destinations.push({ section: s.key, label: `${s.label} · ${t.label}`, href: t.href });
    }
  }
  return NextResponse.json({ destinations });
}
