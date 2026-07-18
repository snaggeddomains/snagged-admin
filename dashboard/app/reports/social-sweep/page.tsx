import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import SocialSweepClient from "../social-sweep-client";

export const dynamic = "force-dynamic";

// /reports/social-sweep = scored domain-opportunity posts skimmed from Reddit (and X).
export default async function SocialSweepPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/social-sweep");
  if (!canReports(user, "reports.social_sweep")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">This report needs the <code>reports.social_sweep</code> permission.</p>
      </main>
    );
  }
  return <SocialSweepClient />;
}
