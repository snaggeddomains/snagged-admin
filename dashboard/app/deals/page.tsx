import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import BoardClient from "./board-client";

export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals");
  if (!canEnterDeals(user)) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The Deals board needs the <code>deals</code> permission.</p>
      </main>
    );
  }
  return <BoardClient />;
}
