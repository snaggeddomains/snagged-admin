"use client";

import { usePathname } from "next/navigation";
import TopBar from "@/app/top-bar";
import Nav from "@/app/nav";
import type { AppUser } from "@/lib/permissions";

type Tab = { href: string; label: string };

// SNAP Opportunities' page still lives under /reports/* but belongs to the SNAP
// workspace, not Reports. This client wrapper picks the chrome by pathname: on
// /reports/opportunities it renders the SNAP header + SNAP sub-nav; on every other
// /reports/* page it renders the Reports header + Reports sub-nav. The tab lists
// are filtered server-side (in the layout) and passed in.
export default function ReportsChrome({
  user,
  reportsTabs,
  snapTabs,
}: {
  user: AppUser;
  reportsTabs: Tab[];
  snapTabs: Tab[];
}) {
  const pathname = usePathname();
  const inSnap = Boolean(pathname && pathname.startsWith("/reports/opportunities"));
  return inSnap ? (
    <>
      <TopBar user={user} current="snap" />
      <Nav tabs={snapTabs} />
    </>
  ) : (
    <>
      <TopBar user={user} current="reports" />
      <Nav tabs={reportsTabs} />
    </>
  );
}
