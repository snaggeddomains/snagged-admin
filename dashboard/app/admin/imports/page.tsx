import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import { isNamingConfigured } from "@/lib/naming";
import { isMasterlistConfigured } from "@/lib/masterlist";
import ImportsClient from "./imports-client";

export default async function ImportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/admin/imports");
  if (!userCan(user, "admin.imports")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">
          Importing needs the <code>admin.imports</code> permission.
        </p>
      </main>
    );
  }
  return (
    <ImportsClient
      universeReady={isNamingConfigured()}
      masterReady={isMasterlistConfigured()}
    />
  );
}
