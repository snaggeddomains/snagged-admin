import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import EmailHealthClient from "./email-health-client";

export const dynamic = "force-dynamic";

// /reports/email-health = deliverability/health of our sending domains via MXToolbox.
export default async function EmailHealthPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/email-health");
  if (!canReports(user, "reports.email_health")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The Email Health report needs the <code>reports.email_health</code> permission.</p>
      </main>
    );
  }
  return <EmailHealthClient />;
}
