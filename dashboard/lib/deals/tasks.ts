// My Tasks — a person's Deals to-do list, aggregated live from existing data (no task table
// to maintain). Four buckets:
//   • replies      — a comment @mentioned you and you haven't replied since
//   • assignments  — deals assigned to you that you haven't touched yet (new on your plate)
//   • boomerangs    — deals you snoozed whose revisit date has arrived
//   • shared        — deals someone shared/looped you into
// Each clears itself naturally as the underlying condition resolves (you reply, you act,
// the reminder is done, the share is removed).

import { getDb, isDbConfigured } from "../supabase";
import { listDeals, getDealsByIds, type Deal, type Activity } from "./store";
import { dueReminders, type Reminder } from "./reminders";
import { sharesFor } from "./sharing";

const lc = (e: string): string => String(e || "").trim().toLowerCase();

export type ReplyTask = { deal: Deal; comment: { id: string; body: string | null; user_email: string | null; created_at: string } };
export type BoomerangTask = { deal: Deal; reminder: Reminder };
export type SharedTask = { deal: Deal; shared_by: string | null; created_at: string };

export type MyTasks = {
  replies: ReplyTask[];
  assignments: Deal[];
  boomerangs: BoomerangTask[];
  shared: SharedTask[];
  counts: { replies: number; assignments: number; boomerangs: number; shared: number; actionable: number };
};

type ActRow = Activity & { deal_id: string };

// Comments/notes mentioning me that I haven't replied to since.
async function repliesNeeded(me: string): Promise<ReplyTask[]> {
  if (!isDbConfigured()) return [];
  const { data } = await getDb().from("deal_activity")
    .select("id,deal_id,body,user_email,created_at,meta,kind")
    .in("kind", ["comment", "note"]).contains("meta", { mentions: [me] })
    .order("created_at", { ascending: false }).limit(100);
  const rows = (data || []) as ActRow[];
  if (!rows.length) return [];
  // Latest mention of me per deal (desc order → first seen is newest), skipping my own.
  const latestByDeal = new Map<string, ActRow>();
  for (const r of rows) {
    if (lc(r.user_email || "") === me) continue;
    if (!latestByDeal.has(r.deal_id)) latestByDeal.set(r.deal_id, r);
  }
  const dealIds = [...latestByDeal.keys()];
  if (!dealIds.length) return [];
  // My latest comment per deal → drop the ones I've already replied to since the mention.
  const { data: mine } = await getDb().from("deal_activity").select("deal_id,created_at")
    .in("kind", ["comment", "note"]).eq("user_email", me).in("deal_id", dealIds)
    .order("created_at", { ascending: false });
  const myLatest = new Map<string, string>();
  for (const r of (mine || []) as { deal_id: string; created_at: string }[]) if (!myLatest.has(r.deal_id)) myLatest.set(r.deal_id, r.created_at);
  const pending = dealIds.filter((id) => {
    const replied = myLatest.get(id);
    return !replied || replied < latestByDeal.get(id)!.created_at;
  });
  const byId = new Map((await getDealsByIds(pending)).map((d) => [d.id, d]));
  return pending
    .map((id) => { const d = byId.get(id); const m = latestByDeal.get(id)!; return d ? { deal: d, comment: { id: m.id, body: m.body, user_email: m.user_email, created_at: m.created_at } } : null; })
    .filter(Boolean) as ReplyTask[];
}

// Open deals owned by me that I haven't touched yet — freshly assigned, on my plate.
async function newAssignments(me: string): Promise<Deal[]> {
  const myOpen = await listDeals({ all: false, me, status: "open" }).catch(() => [] as Deal[]);
  if (!myOpen.length) return [];
  const openIds = myOpen.map((d) => d.id);
  const touched = new Set<string>();
  if (isDbConfigured()) {
    const { data } = await getDb().from("deal_activity").select("deal_id").eq("user_email", me).in("deal_id", openIds);
    for (const r of (data || []) as { deal_id: string }[]) touched.add(r.deal_id);
  }
  return myOpen.filter((d) => !touched.has(d.id)).sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
}

export async function myTasks(email: string): Promise<MyTasks> {
  const me = lc(email);
  const [replies, assignments, dueRems, shares] = await Promise.all([
    repliesNeeded(me).catch(() => [] as ReplyTask[]),
    newAssignments(me).catch(() => [] as Deal[]),
    dueReminders(me).catch(() => [] as Reminder[]),
    sharesFor(me).catch(() => []),
  ]);
  const remById = new Map((await getDealsByIds(dueRems.map((r) => r.deal_id))).map((d) => [d.id, d]));
  const boomerangs = dueRems.map((r) => { const d = remById.get(r.deal_id); return d ? { deal: d, reminder: r } : null; }).filter(Boolean) as BoomerangTask[];
  const shById = new Map((await getDealsByIds(shares.map((s) => s.deal_id))).map((d) => [d.id, d]));
  const shared = shares.map((s) => { const d = shById.get(s.deal_id); return d ? { deal: d, shared_by: s.shared_by, created_at: s.created_at } : null; }).filter(Boolean) as SharedTask[];
  const counts = {
    replies: replies.length, assignments: assignments.length, boomerangs: boomerangs.length, shared: shared.length,
    actionable: replies.length + boomerangs.length,   // the "needs you now" badge (mentions + due boomerangs)
  };
  return { replies, assignments, boomerangs, shared, counts };
}
