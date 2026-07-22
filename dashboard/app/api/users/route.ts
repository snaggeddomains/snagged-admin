// User/permission administration API. Gated by the `admin.users.manage` action.
// Reads/writes domain_research_users via the service-role client.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction, type AppUser } from "@/lib/permissions";
import { listUsers, updateUserAccess, createUser, deleteUser } from "@/lib/users";

export const runtime = "nodejs";

// Best-effort: ask research to email a set-password link to a freshly created
// user. Research owns the real password hashing (scrypt) + email, so we never
// reimplement it here. Failure is non-fatal — the user can use "Forgot password".
async function sendInvite(email: string): Promise<boolean> {
  const origin = (process.env.RESEARCH_ORIGIN || "https://research.snagged.com").replace(/\/$/, "");
  try {
    const res = await fetch(`${origin}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // mode:"invite" → research sends invite-flavored copy + a 7-day link
      // instead of the 1-hour "reset your password" email.
      body: JSON.stringify({ action: "reset-request", email, mode: "invite" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

type Gate =
  | { ok: false; error: string; status: 401 | 403 }
  | { ok: true; me: AppUser };

async function requireManager(): Promise<Gate> {
  const me = await getCurrentUser();
  if (!me) return { ok: false, error: "Not authenticated", status: 401 };
  if (!userCanAction(me, "admin.users.manage")) {
    return { ok: false, error: "Forbidden", status: 403 };
  }
  return { ok: true, me };
}

export async function GET() {
  const gate = await requireManager();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });
  return NextResponse.json({ users: await listUsers() });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireManager();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = (await req.json().catch(() => null)) as {
    id?: string;
    is_admin?: boolean;
    permissions?: Record<string, unknown>;
    first_name?: string;
    last_name?: string;
  } | null;
  if (!body?.id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });

  // Footgun guard: don't let an admin strip their own admin and lock themselves out.
  if (body.id === gate.me.id && body.is_admin === false) {
    return NextResponse.json(
      { error: "You can't remove your own admin access." },
      { status: 400 },
    );
  }

  const updated = await updateUserAccess(body.id, {
    is_admin: body.is_admin,
    permissions: body.permissions,
    first_name: body.first_name,
    last_name: body.last_name,
  });
  if (!updated) return NextResponse.json({ error: "Update failed" }, { status: 500 });
  return NextResponse.json({ user: updated });
}

export async function POST(req: NextRequest) {
  const gate = await requireManager();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = (await req.json().catch(() => null)) as {
    email?: string;
    is_admin?: boolean;
    permissions?: Record<string, unknown>;
  } | null;
  if (!body?.email) return NextResponse.json({ error: "Missing email" }, { status: 400 });

  const { user, error } = await createUser({
    email: body.email,
    is_admin: body.is_admin,
    permissions: body.permissions,
  });
  if (error || !user) return NextResponse.json({ error: error || "Create failed" }, { status: 400 });

  const invited = await sendInvite(user.email);
  return NextResponse.json({ user, invited });
}

export async function DELETE(req: NextRequest) {
  const gate = await requireManager();
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  if (body.id === gate.me.id) {
    return NextResponse.json({ error: "You can't delete your own account." }, { status: 400 });
  }

  const result = await deleteUser(body.id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Delete failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
