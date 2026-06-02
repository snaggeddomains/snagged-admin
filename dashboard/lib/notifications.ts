// In-app notifications (the bell), read from the MAIN research DB
// (domain_research_notifications) — the same table the research module writes to
// when a report finishes or a lesson is submitted. getDb() points at that
// project, so the admin bell and the research bell share one source of truth.

import { getDb, isDbConfigured } from "./supabase";

const TABLE = "domain_research_notifications";

export type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
};

/** Newest notifications for a user (default 20). */
export async function listNotifications(userId: string, limit = 20): Promise<Notification[]> {
  if (!isDbConfigured() || !userId) return [];
  const { data, error } = await getDb()
    .from(TABLE)
    .select("id,kind,title,body,link,read_at,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []) as Notification[];
}

/** Count of unread notifications for a user. */
export async function countUnread(userId: string): Promise<number> {
  if (!isDbConfigured() || !userId) return 0;
  const { count, error } = await getDb()
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", "null");
  if (error) return 0;
  return count ?? 0;
}

/** Mark notifications read — specific ids, or all of the user's when ids omitted. */
export async function markRead(userId: string, ids?: string[]): Promise<void> {
  if (!isDbConfigured() || !userId) return;
  let q = getDb().from(TABLE).update({ read_at: new Date().toISOString() }).eq("user_id", userId).is("read_at", "null");
  if (ids && ids.length) q = q.in("id", ids);
  await q;
}
