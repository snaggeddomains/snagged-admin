import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import ReportsChrome from "./reports-chrome";
import { getCurrentUser } from "@/lib/session";
import { canEnterReports, canReports, userCan, REPORTS_TABS, SNAP_TABS } from "@/lib/permissions";

// The Reports module shell — a top-level module (peer to Admin), with its own
// permission so analytics can be granted without admin powers. Same chrome as
// Admin: global TopBar + sub-nav (which collapses into the mobile hamburger).
export default async function ReportsLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports");

  if (!canEnterReports(user)) {
    return (
      <>
        <TopBar user={user} />
        <main>
          <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
          <p className="muted">
            Your account doesn&apos;t have Reports access. Ask an administrator for the{" "}
            <code>reports</code> permission (or a specific report).
          </p>
        </main>
      </>
    );
  }

  const reportsTabs = REPORTS_TABS.filter((t) => canReports(user, t.perm)).map((t) => ({ href: t.href, label: t.label }));
  // SNAP sub-nav (Eval + Opportunities) — shown on /reports/opportunities, which
  // belongs to the SNAP workspace. Each tab gated by its own kind.
  const snapTabs = SNAP_TABS.filter((t) =>
    t.perm === "reports.opportunities" ? canReports(user, t.perm) : userCan(user, t.perm as Parameters<typeof userCan>[1]),
  ).map((t) => ({ href: t.href, label: t.label }));
  return (
    <>
      <ReportsChrome user={user} reportsTabs={reportsTabs} snapTabs={snapTabs} />
      {children}
    </>
  );
}
