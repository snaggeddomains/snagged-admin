import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import SectionChrome from "@/app/section-chrome";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

// SNAP Deals — Sam's lean internal acquisition tracker, a submodule under the SNAP menu.
// Chrome is the shared SectionChrome (resolves to the SNAP section from the URL). Gated by
// the single `snap.deals` view+edit permission.
export default async function SnapDealsLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/snap-deals");
  if (!userCan(user, "snap.deals")) {
    return (
      <>
        <TopBar user={user} />
        <main>
          <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
          <p className="muted">
            The SNAP Deals board needs the <code>snap.deals</code> permission. Ask an administrator to grant it.
          </p>
        </main>
      </>
    );
  }
  return (
    <>
      {/* Widen the centered .wrap to full width on these routes (see snagged-brand.css). */}
      <div data-deals-fullbleed hidden />
      <SectionChrome user={user} />
      {children}
    </>
  );
}
