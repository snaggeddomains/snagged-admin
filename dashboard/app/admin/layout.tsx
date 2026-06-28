import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import SectionChrome from "@/app/section-chrome";
import { getCurrentUser } from "@/lib/session";
import { canEnterAdmin } from "@/lib/permissions";

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

  return (
    <>
      <SectionChrome user={user} />
      {children}
    </>
  );
}
