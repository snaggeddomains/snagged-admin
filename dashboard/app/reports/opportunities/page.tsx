import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import OpportunitiesClient from "./opportunities-client";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/opportunities");
  if (!canReports(user, "reports.opportunities")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          SNAP Opportunities needs the <code>reports.opportunities</code> permission.
        </p>
      </main>
    );
  }
  return <OpportunitiesClient />;
}
