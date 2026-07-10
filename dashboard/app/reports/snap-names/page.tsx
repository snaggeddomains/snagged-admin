import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import SnapNamesClient from "./snap-names-client";

export const dynamic = "force-dynamic";

export default async function SnapNamesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/snap-names");
  if (!canReports(user, "reports.snap_names")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          SNAP Names needs the <code>reports.snap_names</code> permission.
        </p>
      </main>
    );
  }
  return <SnapNamesClient canWrite={canReports(user, "reports.snap_names.write")} />;
}
