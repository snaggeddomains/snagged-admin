import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import SeoClient from "./seo-client";

export const dynamic = "force-dynamic";

// /reports/seo = high-intent keyword rank tracking + weekly action loop (GSC + GA + Ahrefs).
export default async function SeoPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/seo");
  if (!canReports(user, "reports.seo")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">The SEO report needs the <code>reports.seo</code> permission.</p>
      </main>
    );
  }
  return <SeoClient />;
}
