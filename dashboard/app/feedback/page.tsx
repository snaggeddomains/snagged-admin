import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import TopBar from "@/app/top-bar";
import FeedbackClient from "./feedback-client";

export const dynamic = "force-dynamic";

// Feedback / Feature Requests — open to EVERY logged-in user (submit + see their own). Rob
// additionally sees + manages the whole queue (admin.feedback.manage; admins auto-pass).
export default async function FeedbackPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/feedback");
  return (
    <main>
      <TopBar user={user} />
      <FeedbackClient />
    </main>
  );
}
