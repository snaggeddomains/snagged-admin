import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import ClientOverlapClient from "../client-overlap-client";

export const dynamic = "force-dynamic";

// /reports/client-overlap = new marketplace/auction names that match a client's domains.
export default async function ClientOverlapPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/client-overlap");
  if (!canReports(user, "reports.client_overlap")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          This report needs the <code>reports.client_overlap</code> permission.
        </p>
      </main>
    );
  }
  return <ClientOverlapClient />;
}
