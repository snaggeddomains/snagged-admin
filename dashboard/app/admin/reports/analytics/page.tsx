import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import AnalyticsClient from "./analytics-client";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin/reports/analytics");
  if (!canAdmin(user, "admin.reports.analytics")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          Site Analytics needs the <code>admin.reports.analytics</code> permission.
        </p>
      </main>
    );
  }
  // The sub-nav offers the cost report too, but only if this user can open it.
  const canCost = canAdmin(user, "admin.reports.cost");
  return <AnalyticsClient canCost={canCost} />;
}
