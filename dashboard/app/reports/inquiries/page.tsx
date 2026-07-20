import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import InquiriesClient from "./inquiries-client";

export const dynamic = "force-dynamic";

export default async function InquiriesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/inquiries");
  if (!userCan(user, "research.pipedrive")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          Buy-Side Inquiries needs the <code>research.pipedrive</code> permission.
        </p>
      </main>
    );
  }
  return <InquiriesClient />;
}
