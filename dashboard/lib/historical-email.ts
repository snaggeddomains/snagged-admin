// Email signups + unsubscribes by day. The bundled historical-email.json is the
// SEED (from the audience export — OPTIN_TIME / UNSUB_TIME, PII-stripped); forward
// data is pulled live from the Mailchimp members API and merged on top, so the
// trend auto-refreshes without re-exporting. See lib/mailchimp.ts#recentMemberCounts.

import data from "./historical-email.json";

export type DayCount = { date: string; count: number };

export const emailDataThrough: string = (data as { generated?: string }).generated || "";
export const histSignups: Record<string, number> = (data as { signups?: Record<string, number> }).signups || {};
export const histUnsubs: Record<string, number> = (data as { unsubs?: Record<string, number> }).unsubs || {};

// Merge the historical daily map with a live increment, then filter to [from, to].
export function mergeDaily(hist: Record<string, number>, live: Record<string, number>, from: string, to: string): DayCount[] {
  const m = new Map<string, number>();
  for (const [d, c] of Object.entries(hist)) m.set(d, (m.get(d) || 0) + Number(c));
  for (const [d, c] of Object.entries(live)) m.set(d, (m.get(d) || 0) + Number(c));
  return [...m.entries()]
    .filter(([d]) => d >= from && d <= to)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
