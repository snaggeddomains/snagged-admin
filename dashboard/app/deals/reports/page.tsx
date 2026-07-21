import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals, userCanAction } from "@/lib/permissions";
import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

export default async function DealsReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals/reports");
  if (!canEnterDeals(user) || (!user?.is_admin && !userCanAction(user, "deals.reports"))) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">Deals Reporting needs the <code>deals.reports</code> permission.</p>
      </main>
    );
  }
  return <ReportsClient />;
}
