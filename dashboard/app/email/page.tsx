import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import EmailClient from "./email-client";

export const dynamic = "force-dynamic";

export default async function EmailPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/email");
  if (!userCan(user, "email")) return <main><h1 style={{ fontSize: "1.25rem" }}>No access</h1></main>;
  return <EmailClient />;
}
