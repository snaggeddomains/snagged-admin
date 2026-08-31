import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import DetailClient from "./detail-client";

export const dynamic = "force-dynamic";

export default async function SnapDealPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  const { id } = await params;
  if (!user) redirect(`/login?next=/snap-deals/${id}`);
  if (!userCan(user, "snap.deals")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The SNAP Deal Board needs the <code>snap.deals</code> permission.</p>
      </main>
    );
  }
  return <DetailClient id={id} />;
}
