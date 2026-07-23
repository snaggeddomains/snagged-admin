import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import OwnersClient from "./owners-client";

export const dynamic = "force-dynamic";

export default async function OwnersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals/owners");
  if (!canEnterDeals(user)) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <OwnersClient />;
}
