import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canEnterDeals } from "@/lib/permissions";
import OwnerReviewClient from "./owner-review-client";

export const dynamic = "force-dynamic";

export default async function OwnerReviewPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/deals/owner-review");
  if (!canEnterDeals(user)) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <OwnerReviewClient />;
}
