// Load users from the shared domain_research_users table (service-role).
// Node runtime only.

import crypto from "node:crypto";
import { getDb } from "./supabase";
import type { AppUser } from "./permissions";

const TABLE = "domain_research_users";

// A syntactically-valid but intentionally non-verifiable scrypt hash. New users
// are created with this and must set a real password via the reset-email flow
// (research's reset-confirm does the real hashing). Because it's random, no
// password ever verifies against it — exactly what we want for a pending invite.
function placeholderHash(): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.randomBytes(32).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

/** Create a user (pending password). Returns the row or a friendly error. */
export async function createUser(input: {
  email: string;
  is_admin?: boolean;
  permissions?: Record<string, unknown>;
}): Promise<{ user?: AppUser; error?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) return { error: "Enter a valid email." };
  const { data, error } = await getDb()
    .from(TABLE)
    .insert({
      email,
      password_hash: placeholderHash(),
      is_admin: input.is_admin ?? false,
      permissions: input.permissions ?? {},
    })
    .select("id, email, is_admin, permissions")
    .maybeSingle();
  if (error) {
    if (error.code === "23505" || /duplicate|unique/i.test(error.message)) {
      return { error: "A user with that email already exists." };
    }
    return { error: error.message };
  }
  if (!data) return { error: "Create failed." };
  return { user: rowToUser(data) };
}

/** Delete a user. Related rows (runs, naming, lessons) FK to ON DELETE SET NULL. */
export async function deleteUser(id: string): Promise<boolean> {
  const { error } = await getDb().from(TABLE).delete().eq("id", id);
  return !error;
}

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
