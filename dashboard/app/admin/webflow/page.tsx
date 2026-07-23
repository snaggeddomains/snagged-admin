import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import WebflowClient from "./webflow-client";

export const dynamic = "force-dynamic";

export default async function WebflowPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin/webflow");
  if (!canAdmin(user, "admin.webflow")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">Managing the Webflow Marketplace needs the <code>admin.webflow</code> permission.</p>
      </main>
    );
  }
  return <WebflowClient />;
}
