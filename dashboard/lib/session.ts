// Load the current user for server components, from the shared dr_auth cookie.
// Node runtime (reads Supabase) — do not import from middleware.

import { cookies } from "next/headers";
import { COOKIE, verifyCookie, authSecret } from "./auth";
import { getUser } from "./users";
import type { AppUser } from "./permissions";

export async function getCurrentUser(): Promise<AppUser | null> {
  const token = cookies().get(COOKIE)?.value;
  const session = await verifyCookie(token, authSecret());
  if (!session?.u) return null;
  return getUser(session.u);
}
