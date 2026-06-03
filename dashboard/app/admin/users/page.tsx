import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { canAdmin } from "@/lib/permissions";
import { listUsers } from "@/lib/users";
import UsersEditor from "./users-editor";

export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await getCurrentUser();
  if (!me) redirect("/login?next=/admin/users");

  if (!canAdmin(me, "admin.users.manage")) {
    return (
      <main>
        <h1 style={{ fontSize: "1.1rem" }}>No access</h1>
        <p className="muted">
          You need the <code>admin.users.manage</code> permission to manage users.
        </p>
      </main>
    );
  }

  const users = await listUsers();
  return <UsersEditor users={users} currentUserId={me.id} />;
}
