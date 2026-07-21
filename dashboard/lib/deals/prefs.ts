// Per-user notification preferences for deal events (assignment, stage change, @mention).
// Stored in domain_research_users.notif_prefs.deal = { in_app, email, slack }. Default all
// on, so a user who never touched settings still gets everything.

import { getDb } from "../supabase";

const TABLE = "domain_research_users";
export type Channels = { in_app: boolean; email: boolean; slack: boolean };
const DEFAULT: Channels = { in_app: true, email: true, slack: true };

function read(row: unknown): Channels {
  const p = (row as { notif_prefs?: { deal?: Partial<Channels> } } | null)?.notif_prefs?.deal;
  if (!p) return { ...DEFAULT };
  return { in_app: p.in_app !== false, email: p.email !== false, slack: p.slack !== false };
}

export async function channelsFor(email: string): Promise<Channels> {
  try {
    const { data } = await getDb().from(TABLE).select("notif_prefs").eq("email", email.toLowerCase()).maybeSingle();
    return read(data);
  } catch { return { ...DEFAULT }; }
}

export async function getMyPrefs(email: string): Promise<Channels> {
  return channelsFor(email);
}

export async function setMyPrefs(email: string, ch: Channels): Promise<Channels> {
  const clean: Channels = { in_app: !!ch.in_app, email: !!ch.email, slack: !!ch.slack };
  const { data } = await getDb().from(TABLE).select("notif_prefs").eq("email", email.toLowerCase()).maybeSingle();
  const prefs = { ...((data as { notif_prefs?: object } | null)?.notif_prefs || {}), deal: clean };
  await getDb().from(TABLE).update({ notif_prefs: prefs }).eq("email", email.toLowerCase());
  return clean;
}
