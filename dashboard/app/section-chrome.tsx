"use client";

import { usePathname } from "next/navigation";
import TopBar from "@/app/top-bar";
import Nav from "@/app/nav";
import OwnerReviewBanner from "@/app/owner-review-banner";
import { sectionForPath, sectionTabs } from "@/lib/navigation";
import { canEnterDeals, type AppUser } from "@/lib/permissions";

// The shared module chrome: the global TopBar (with the right section highlighted)
// + that section's sub-nav. The section is resolved from the URL via the
// navigation registry, so a page served by one app can still belong to another
// section (e.g. /reports/opportunities → SNAP, /research/portfolio → Reports) with
// no per-page wiring. Used by the admin + reports layouts.
export default function SectionChrome({ user }: { user: AppUser }) {
  const pathname = usePathname();
  const section = sectionForPath(pathname || "");
  const tabs = sectionTabs(user, section).map((t) => ({ href: t.href, label: t.label }));
  return (
    <>
      <TopBar user={user} current={section} />
      <Nav tabs={tabs} />
      {canEnterDeals(user) && <OwnerReviewBanner />}
    </>
  );
}
