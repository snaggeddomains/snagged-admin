import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import BoardClient from "./board-client";

export const dynamic = "force-dynamic";

export default async function SnapDealsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/snap-deals");
  if (!userCan(user, "snap.deals")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The SNAP Deals board needs the <code>snap.deals</code> permission.</p>
      </main>
    );
  }
  return <BoardClient />;
}
