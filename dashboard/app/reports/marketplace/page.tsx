import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import MarketplaceClient from "./marketplace-client";

export const dynamic = "force-dynamic";

// /reports/marketplace = the per-domain Marketplace traffic + inquiries report.
export default async function MarketplacePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/marketplace");
  if (!canReports(user, "reports.marketplace")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          The Marketplace report needs the <code>reports.marketplace</code> permission.
        </p>
      </main>
    );
  }
  return <MarketplaceClient />;
}
