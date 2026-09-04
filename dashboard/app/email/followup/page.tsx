import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import FollowupClient from "./followup-client";

export const dynamic = "force-dynamic";

export default async function FollowupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/email/followup");
  if (!userCan(user, "email")) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <FollowupClient />;
}
