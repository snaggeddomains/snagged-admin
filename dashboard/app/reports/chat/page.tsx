import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canReports } from "@/lib/permissions";
import { chatConfigured } from "@/lib/chat-analytics";
import ChatClient from "./chat-client";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/reports/chat");
  if (!canReports(user, "reports.chat")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.25rem" }}>No access</h1>
        <p className="muted">Chat Analytics needs the <code>reports.chat</code> permission.</p>
      </main>
    );
  }
  return <ChatClient configured={chatConfigured()} />;
}
