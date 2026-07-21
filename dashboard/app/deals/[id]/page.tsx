import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import DealClient from "./deal-client";

export const dynamic = "force-dynamic";

export default async function DealDetailPage({ params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=/deals/${params.id}`);
  if (!canEnterDeals(user)) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The Deals module needs the <code>deals</code> permission.</p>
      </main>
    );
  }
  return <DealClient id={params.id} />;
}
