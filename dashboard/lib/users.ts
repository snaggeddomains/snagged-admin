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
  return rowToUser(data);
}

/** List all users, ordered by email. */
export async function listUsers(): Promise<AppUser[]> {
  const { data, error } = await getDb()
    .from(TABLE)
    .select("id, email, is_admin, permissions")
    .order("email", { ascending: true });
  if (error || !data) return [];
  return data.map(rowToUser);
}

/** Update a user's role/permissions. Only these two fields are writable here. */
export async function updateUserAccess(
  id: string,
  patch: { is_admin?: boolean; permissions?: Record<string, unknown> },
): Promise<AppUser | null> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof patch.is_admin === "boolean") update.is_admin = patch.is_admin;
  if (patch.permissions) update.permissions = patch.permissions;
  const { data, error } = await getDb()
    .from(TABLE)
    .update(update)
    .eq("id", id)
    .select("id, email, is_admin, permissions")
    .maybeSingle();
  if (error || !data) return null;
  return rowToUser(data);
}

function rowToUser(data: Record<string, unknown>): AppUser {
  return {
    id: data.id as string,
    email: data.email as string,
    is_admin: Boolean(data.is_admin),
    permissions: (data.permissions as Record<string, unknown>) ?? {},
  };
}
