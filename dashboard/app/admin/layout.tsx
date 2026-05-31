import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import Nav from "@/app/nav";
import { getCurrentUser } from "@/lib/session";
import { userCan, MODULES } from "@/lib/permissions";

// The Admin module shell: the wordmark header, the module-aware nav, and the
// module-level gate. Middleware guarantees an authenticated session reaches
// here; this enforces the `admin` permission on top of that.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin");

  if (!userCan(user, "admin")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          Your account doesn&apos;t have the <code>admin</code> permission. Ask an
          administrator to grant it.
        </p>
      </main>
    );
  }

  const canResearch = MODULES.some(
    (m) => m.startsWith("research.") && userCan(user, m),
  );
  const researchHref = process.env.RESEARCH_ORIGIN || "https://research.snagged.com";

  return (
    <>
      <header style={{ marginBottom: 20 }}>
        <div className="wordmark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
          <span className="wm-a">Snagged</span> <span className="wm-b">Admin</span>
        </div>
        <p className="muted" style={{ marginTop: 6, marginBottom: 0, fontSize: 14 }}>
          Marketplace pipeline dashboard
        </p>
      </header>
      <Nav canResearch={canResearch} researchHref={researchHref} />
      {children}
    </>
  );
}
