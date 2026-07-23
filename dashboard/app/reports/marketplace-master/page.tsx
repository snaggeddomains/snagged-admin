import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import MasterClient from "./master-client";

export const dynamic = "force-dynamic";

// /reports/marketplace-master = every Webflow CMS field for every Marketplace listing.
export default async function MarketplaceMasterPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/marketplace-master");
  if (!canReports(user, "reports.marketplace")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">Marketplace Master needs the <code>reports.marketplace</code> permission.</p>
      </main>
    );
  }
  return <MasterClient />;
}
