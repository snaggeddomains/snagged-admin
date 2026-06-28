import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import SectionChrome from "@/app/section-chrome";
import { getCurrentUser } from "@/lib/session";
import { canEnterReports } from "@/lib/permissions";

// The Reports module shell — a top-level module (peer to Admin), with its own
// permission so analytics can be granted without admin powers. The chrome
// (TopBar + sub-nav) is the shared SectionChrome, which resolves the section from
// the URL — so /reports/opportunities renders under SNAP automatically.
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

  return (
    <>
      <SectionChrome user={user} />
      {children}
    </>
  );
}
