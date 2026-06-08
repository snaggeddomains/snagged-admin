// Historical Mailchimp signups + unsubscribes by day, from the audience export
// (OPTIN_TIME across all members; UNSUB_TIME for unsubscribers). Pre-aggregated to
// daily counts, no PII. Mailchimp's API doesn't expose granular daily signup/unsub
// history, so this export IS the source for the Email tab's signup/unsub trend —
// refresh by re-exporting and regenerating historical-email.json.

import data from "./historical-email.json";

export type DayCount = { date: string; count: number };

const SIGNUPS: Record<string, number> = (data as { signups?: Record<string, number> }).signups || {};
const UNSUBS: Record<string, number> = (data as { unsubs?: Record<string, number> }).unsubs || {};
export const emailDataThrough: string = (data as { generated?: string }).generated || "";

// Daily counts within [from, to] (YYYY-MM-DD), sorted ascending.
export function emailDaily(kind: "signups" | "unsubs", from: string, to: string): DayCount[] {
  const src = kind === "signups" ? SIGNUPS : UNSUBS;
  return Object.entries(src)
    .filter(([d]) => d >= from && d <= to)
    .map(([date, count]) => ({ date, count: Number(count) || 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
