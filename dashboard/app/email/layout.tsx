import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import TopBar from "@/app/top-bar";
import SectionChrome from "@/app/section-chrome";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

// The Email module shell — search the deal inbox for a thread and draft a reply with AI
// (draft-only, copy/paste). A top-level section peer to Research/Admin/SNAP/Reports/Deals.
export default async function EmailLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/email");
  if (!userCan(user, "email")) {
    return (
      <>
        <TopBar user={user} />
        <main>
          <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
          <p className="muted">
            The Email module needs the <code>email</code> permission. Ask an administrator to grant it.
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
