import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import ListClient from "./list-client";

export const dynamic = "force-dynamic";

export default async function DealsListPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals/list");
  if (!canEnterDeals(user)) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <ListClient />;
}
