import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Nav from "@/app/nav";
import TopBar from "@/app/top-bar";
import { getCurrentUser } from "@/lib/session";
import { canEnterAdmin, canAdmin, ADMIN_TABS } from "@/lib/permissions";

// The Admin module shell: global TopBar (cross-module switching + account),
// the admin sub-nav, and the module-level gate. Middleware guarantees an
// authenticated session reaches here; this enforces the `admin` permission.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");

  if (!canEnterAdmin(user)) {
    return (
      <>
        <TopBar user={user} />
        <main>
          <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
          <p className="muted">
            Your account doesn&apos;t have any Admin permissions. Ask an
            administrator to grant a specific tab (e.g. Imports) or full access.
          </p>
        </main>
      </>
    );
  }

  // Per-tab gating: only show the tabs this user can actually open.
  const tabs = ADMIN_TABS.filter((t) => canAdmin(user, t.perm)).map((t) => ({ href: t.href, label: t.label }));

  return (
    <>
      <TopBar user={user} current="admin" />
      <Nav tabs={tabs} />
      {children}
    </>
  );
}
