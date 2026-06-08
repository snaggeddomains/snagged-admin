import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canAdmin, isGranted } from "@/lib/permissions";
import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin/reports");
  if (!canAdmin(user, "admin.reports")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          The Reports tab needs the <code>admin.reports</code> permission.
        </p>
      </main>
    );
  }
  // The cost report itself is gated one level finer. Editing RATES, however, is
  // restricted to actual admins (is_admin or the `admin` umbrella) — a user with
  // only admin.reports.cost can view costs but not change the dollar rates.
  const canCost = canAdmin(user, "admin.reports.cost");
  const canEditRates = Boolean(user.is_admin) || isGranted(user.permissions, "admin");
  // Site Analytics sits alongside the cost report under the same Reports tab; the
  // in-page sub-nav links to it when this user can also open it.
  const canAnalytics = canAdmin(user, "admin.reports.analytics");
  return <ReportsClient canCost={canCost} canEditRates={canEditRates} canAnalytics={canAnalytics} />;
}
