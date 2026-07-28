// Deal sharing — grant a colleague VIEW + COMMENT access to a specific deal (they can
// read the whole deal and reply in comments / @mention, but not edit fields, move stages,
// or reassign — the owner stays in control). Shares are created explicitly (Share button)
// or implicitly when you @mention someone in a comment. All best-effort + fail-open.

import { getDb, isDbConfigured } from "../supabase";

const SHARES = "deal_shares";

const lc = (e: string): string => String(e || "").trim().toLowerCase();

// Emails a deal is shared with (lowercased).
export async function listSharesForDeal(dealId: string): Promise<string[]> {
  if (!isDbConfigured() || !dealId) return [];
  const { data, error } = await getDb().from(SHARES).select("user_email").eq("deal_id", dealId);
  if (error || !data) return [];
  return (data as { user_email: string }[]).map((r) => lc(r.user_email)).filter(Boolean);
}

// Is this deal shared with this user?
export async function isSharedWith(dealId: string, email: string): Promise<boolean> {
  if (!isDbConfigured() || !dealId || !email) return false;
  const { data, error } = await getDb().from(SHARES).select("id").eq("deal_id", dealId).eq("user_email", lc(email)).maybeSingle();
  return !error && !!data;
}

// Deal ids shared WITH a user (for the "Shared with me" board scope + My Tasks).
export async function sharedDealIdsFor(email: string): Promise<string[]> {
  if (!isDbConfigured() || !email) return [];
  const { data, error } = await getDb().from(SHARES).select("deal_id").eq("user_email", lc(email));
  if (error || !data) return [];
  return [...new Set((data as { deal_id: string }[]).map((r) => r.deal_id).filter(Boolean))];
}

// The share rows for a user (deal_id + who shared + when) — powers the My Tasks "shared" bucket.
export type ShareRow = { deal_id: string; shared_by: string | null; created_at: string };
export async function sharesFor(email: string): Promise<ShareRow[]> {
  if (!isDbConfigured() || !email) return [];
  const { data, error } = await getDb().from(SHARES).select("deal_id,shared_by,created_at")
    .eq("user_email", lc(email)).order("created_at", { ascending: false });
  if (error || !data) return [];
  return data as ShareRow[];
}

// Grant access to one or more colleagues. Idempotent (unique on deal+user). Skips the
// person who's sharing (no self-share). Returns the emails NEWLY added.
export async function shareDeal(dealId: string, emails: string[], sharedBy: string | null): Promise<string[]> {
  if (!isDbConfigured() || !dealId) return [];
  const by = sharedBy ? lc(sharedBy) : null;
  const want = [...new Set(emails.map(lc).filter((e) => e && e !== by))];
  if (!want.length) return [];
  const existing = new Set(await listSharesForDeal(dealId));
  const fresh = want.filter((e) => !existing.has(e));
  if (!fresh.length) return [];
  const rows = fresh.map((user_email) => ({ deal_id: dealId, user_email, shared_by: by }));
  const { error } = await getDb().from(SHARES).upsert(rows, { onConflict: "deal_id,user_email", ignoreDuplicates: true });
  if (error) return [];
  return fresh;
}

// Revoke a share.
export async function unshareDeal(dealId: string, email: string): Promise<void> {
  if (!isDbConfigured() || !dealId || !email) return;
  await getDb().from(SHARES).delete().eq("deal_id", dealId).eq("user_email", lc(email));
}
