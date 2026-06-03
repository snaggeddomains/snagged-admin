import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
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
  // The cost report itself is gated one level finer.
  const canCost = canAdmin(user, "admin.reports.cost");
  return <ReportsClient canCost={canCost} />;
}
