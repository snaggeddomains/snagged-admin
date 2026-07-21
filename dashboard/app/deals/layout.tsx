import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import SectionChrome from "@/app/section-chrome";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";

// The Deals module shell — the native buy-side CRM, a top-level module peer to
// Research/Admin/SNAP/Reports. Chrome is the shared SectionChrome (TopBar + sub-nav,
// resolved from the URL via the navigation registry).
export default async function DealsLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals");
  if (!canEnterDeals(user)) {
    return (
      <>
        <TopBar user={user} />
        <main>
          <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
          <p className="muted">
            The Deals board needs the <code>deals</code> permission. Ask an administrator to grant it.
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
