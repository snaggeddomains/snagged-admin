"use client";

import { usePathname } from "next/navigation";
import TopBar from "@/app/top-bar";
import Nav from "@/app/nav";
import OwnerReviewBanner from "@/app/owner-review-banner";
import { sectionForPath, sectionTabs, toolsGroups } from "@/lib/navigation";
import { canEnterDeals, type AppUser } from "@/lib/permissions";

// The shared module chrome: the global TopBar (with the right section highlighted)
// + that section's sub-nav. The section is resolved from the URL via the
// navigation registry, so a page served by one app can still belong to another
// section (e.g. /reports/opportunities → SNAP, /research/portfolio → Reports) with
// no per-page wiring. Used by the admin + reports layouts.
export default function SectionChrome({ user }: { user: AppUser }) {
  const pathname = usePathname();
  const section = sectionForPath(pathname || "");
  // Tools renders a 3rd tier — named group dropdowns; every other section is a flat tab row.
  const groups = section === "tools"
    ? toolsGroups(user).map((g) => ({ label: g.label, tabs: g.tabs.map((t) => ({ href: t.href, label: t.label })) }))
    : null;
  const tabs = groups ? undefined : sectionTabs(user, section).map((t) => ({ href: t.href, label: t.label }));
  return (
    <>
      <TopBar user={user} current={section} />
      {groups ? <Nav groups={groups} /> : <Nav tabs={tabs} />}
      {canEnterDeals(user) && <OwnerReviewBanner />}
    </>
  );
}
