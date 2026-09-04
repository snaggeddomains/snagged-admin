// Email snippets — reusable boilerplate language (engagement terms, call-recap template, …) for the
// Email tools. Shared across the team. Fail-soft: a missing table (migration not run) returns [] and
// writes are no-ops-with-error, so the tools work before the SQL is run.

import { getDb } from "./supabase";

const TABLE = "email_snippets";

export type Snippet = { id: string; title: string; body: string; updated_at: string };

function missingTable(err: unknown): boolean {
  const e = (err || {}) as { code?: string; message?: string };
  const code = e.code || "";
  const msg = (e.message || "").toLowerCase();
  return code === "42P01" || code === "PGRST205" || msg.includes("does not exist") || msg.includes("could not find the table");
}

export async function listSnippets(): Promise<Snippet[]> {
  try {
    const { data, error } = await getDb()
      .from(TABLE)
      .select("id,title,body,updated_at")
      .order("title", { ascending: true });
    if (error) { if (missingTable(error)) return []; throw new Error(error.message); }
    return (data || []) as Snippet[];
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

// Create (no id) or update (id) a snippet. Returns the row, or null if the table isn't there yet.
export async function saveSnippet(
  input: { id?: string; title: string; body: string },
  by: string,
): Promise<Snippet | null> {
  const title = input.title.trim().slice(0, 120);
  const body = input.body.trim().slice(0, 8000);
  if (!title || !body) throw new Error("Title and body are required.");
  try {
    if (input.id) {
      const { data, error } = await getDb()
        .from(TABLE)
        .update({ title, body, updated_at: new Date().toISOString() })
        .eq("id", input.id)
        .select("id,title,body,updated_at")
        .single();
      if (error) { if (missingTable(error)) return null; throw new Error(error.message); }
      return data as Snippet;
    }
    const { data, error } = await getDb()
      .from(TABLE)
      .insert({ title, body, created_by: by })
      .select("id,title,body,updated_at")
      .single();
    if (error) { if (missingTable(error)) return null; throw new Error(error.message); }
    return data as Snippet;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

export async function deleteSnippet(id: string): Promise<void> {
  try {
    const { error } = await getDb().from(TABLE).delete().eq("id", id);
    if (error && !missingTable(error)) throw new Error(error.message);
  } catch (err) {
    if (!missingTable(err)) throw err;
  }
}
