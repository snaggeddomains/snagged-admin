import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import DealClient from "./deal-client";

export const dynamic = "force-dynamic";

// /reports/marketplace/<domain> = the per-domain activity drill-down: GA stats +
// inbound / pitched / active-negotiation buckets + sale status, all sell-side.
export default async function MarketplaceDealPage({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params;
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/reports/marketplace/${domain}`);
  if (!canReports(user, "reports.marketplace")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The Marketplace report needs the <code>reports.marketplace</code> permission.</p>
      </main>
    );
  }
  return <DealClient domain={decodeURIComponent(domain).toLowerCase()} />;
}
