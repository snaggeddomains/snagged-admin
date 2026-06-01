// Admin-set a user's password directly (no email round-trip). Gated by the
// same `admin.users.manage` action as the rest of user administration. Writes a
// research-compatible scrypt hash via the service-role client, so the user can
// sign in immediately with the password the admin sets.

import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { userCanAction } from "@/lib/permissions";
import { setUserPassword } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userCanAction(me, "admin.users.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { id?: string; password?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "Missing user id" }, { status: 400 });
  if (!body.password || body.password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const result = await setUserPassword(body.id, body.password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error || "Couldn't set password" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
