import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import ContentClient from "./content-client";

export const dynamic = "force-dynamic";

// /reports/content = blog posts pulled from the Webflow CMS.
export default async function ContentPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/content");
  if (!canReports(user, "reports.content")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The Content report needs the <code>reports.content</code> permission.</p>
      </main>
    );
  }
  return <ContentClient />;
}
