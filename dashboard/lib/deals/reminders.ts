// Deal boomerangs — a PERSONAL "revisit this deal on <date>" reminder. Everyone sets their
// own; a due reminder surfaces in that user's My Tasks. One active reminder per (deal,user):
// setting a new one supersedes the prior active one. All best-effort + fail-open.

import { getDb, isDbConfigured } from "../supabase";

const REM = "deal_reminders";
const lc = (e: string): string => String(e || "").trim().toLowerCase();

export type Reminder = {
  id: string;
  deal_id: string;
  user_email: string;
  remind_at: string;
  note: string | null;
  done: boolean;
  created_by: string | null;
  created_at: string;
};

// The user's active (not-done) reminder for a deal, if any — shown on the deal detail.
export async function reminderForDeal(dealId: string, email: string): Promise<Reminder | null> {
  if (!isDbConfigured() || !dealId || !email) return null;
  const { data, error } = await getDb().from(REM).select("*")
    .eq("deal_id", dealId).eq("user_email", lc(email)).eq("done", false)
    .order("remind_at", { ascending: true }).limit(1).maybeSingle();
  if (error || !data) return null;
  return data as Reminder;
}

// Set / replace the user's boomerang for a deal. Supersedes any prior active one.
export async function setReminder(dealId: string, email: string, remindAt: string, note: string | null, by: string | null): Promise<Reminder | null> {
  if (!isDbConfigured() || !dealId || !email || !remindAt) return null;
  const user_email = lc(email);
  // Clear prior active reminders for this pair, then insert the new one.
  await getDb().from(REM).update({ done: true }).eq("deal_id", dealId).eq("user_email", user_email).eq("done", false);
  const { data, error } = await getDb().from(REM)
    .insert({ deal_id: dealId, user_email, remind_at: remindAt, note: note || null, created_by: by ? lc(by) : null })
    .select("*").single();
  if (error || !data) return null;
  return data as Reminder;
}

// Clear the user's boomerang for a deal (mark done) — e.g. after they revisit it.
export async function clearReminder(dealId: string, email: string): Promise<void> {
  if (!isDbConfigured() || !dealId || !email) return;
  await getDb().from(REM).update({ done: true }).eq("deal_id", dealId).eq("user_email", lc(email)).eq("done", false);
}

// Due boomerangs for a user (remind_at <= now, not done) — feeds My Tasks. Newest-due first.
export async function dueReminders(email: string, now = new Date()): Promise<Reminder[]> {
  if (!isDbConfigured() || !email) return [];
  const { data, error } = await getDb().from(REM).select("*")
    .eq("user_email", lc(email)).eq("done", false).lte("remind_at", now.toISOString())
    .order("remind_at", { ascending: true }).limit(200);
  if (error || !data) return [];
  return data as Reminder[];
}

// ALL not-done reminders for a user (due + upcoming) — the count + "later" section.
export async function pendingReminders(email: string): Promise<Reminder[]> {
  if (!isDbConfigured() || !email) return [];
  const { data, error } = await getDb().from(REM).select("*")
    .eq("user_email", lc(email)).eq("done", false)
    .order("remind_at", { ascending: true }).limit(200);
  if (error || !data) return [];
  return data as Reminder[];
}
