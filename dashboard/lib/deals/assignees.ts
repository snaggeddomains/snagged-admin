// Who can be assigned / @mentioned on a deal — the users flagged "can receive deals"
// (the deals.assignable permission), shown by FIRST + LAST NAME. This is the single
// source for every assignee dropdown + the @mention autocomplete, so the messy "all
// app users" list (dupes / non-deal-takers) is gone.

import { getDb } from "../supabase";
import { isGranted } from "../permissions";

const TABLE = "domain_research_users";
type Row = { id: string; email: string; first_name: string | null; last_name: string | null; permissions: Record<string, unknown> | null };

function nameOf(r: { first_name?: string | null; last_name?: string | null; email: string }): string {
  const n = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  return n || r.email;
}

export async function assignableUsers(): Promise<{ email: string; name: string }[]> {
  const { data, error } = await getDb().from(TABLE).select("id,email,first_name,last_name,permissions");
  if (error || !data) return [];
  return (data as Row[])
    .filter((u) => u.email && isGranted(u.permissions || {}, "deals.assignable"))
    .map((u) => ({ email: u.email, name: nameOf(u) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Full name for one email (for "Assigned to: <name>" in notifications). Falls back to email.
export async function displayName(email?: string | null): Promise<string> {
  if (!email) return "";
  const { data } = await getDb().from(TABLE).select("email,first_name,last_name").eq("email", email.toLowerCase()).maybeSingle();
  return data ? nameOf(data as Row) : email;
}
