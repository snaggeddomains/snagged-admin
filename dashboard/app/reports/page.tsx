import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import AnalyticsClient from "./analytics-client";

export const dynamic = "force-dynamic";

// /reports = the Reports module's default landing: Site Analytics.
export default async function AnalyticsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports");
  if (!canReports(user, "reports.analytics")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          Site Analytics needs the <code>reports.analytics</code> permission.
        </p>
      </main>
    );
  }
  const canCost = canReports(user, "reports.cost");
  return <AnalyticsClient canCost={canCost} />;
}
