// Load users from the shared domain_research_users table (service-role).
// Node runtime only.

import { getDb } from "./supabase";
import type { AppUser } from "./permissions";

const TABLE = "domain_research_users";

/** Load a single user by id. Returns null if not found / not configured. */
export async function getUser(id: string): Promise<AppUser | null> {
  if (!id) return null;
  const { data, error } = await getDb()
    .from(TABLE)
    .select("id, email, is_admin, permissions")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    email: data.email as string,
    is_admin: Boolean(data.is_admin),
    permissions: (data.permissions as Record<string, unknown>) ?? {},
  };
}
