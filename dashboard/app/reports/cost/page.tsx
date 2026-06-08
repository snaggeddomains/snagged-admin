import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports, isGranted } from "@/lib/permissions";
import ReportsClient from "../cost-client";

export const dynamic = "force-dynamic";

// /reports/cost = the API cost & usage report.
export default async function CostPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/cost");
  if (!canReports(user, "reports.cost")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          The cost report needs the <code>reports.cost</code> permission.
        </p>
      </main>
    );
  }
  // Editing RATES is restricted to actual admins (is_admin or the `admin` umbrella)
  // — a user with only reports.cost can view costs but not change the dollar rates.
  const canCost = true;
  const canEditRates = Boolean(user.is_admin) || isGranted(user.permissions, "admin");
  const canAnalytics = canReports(user, "reports.analytics");
  return <ReportsClient canCost={canCost} canEditRates={canEditRates} canAnalytics={canAnalytics} />;
}
