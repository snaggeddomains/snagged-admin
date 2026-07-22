// The buy-side pipeline definition — the board columns, in order. Won/Lost are terminal
// STATUSES (not columns), matching the original Pipedrive design. Kept as plain data so
// adding/renaming a stage is a one-line change (and the board derives from it).

export const STAGES = [
  "Unassigned / Inbox",
  "Assigned",
  "Qualifying",
  "Invoice / Awaiting Payment",
  "Research & Outreach",
  "In Contact",
  "Negotiating",
  "Closed - Won",
  "Closed - Lost",
] as const;
export type Stage = (typeof STAGES)[number];

// Terminal stages ↔ terminal statuses (kept in sync by updateDeal).
export const CLOSED_WON_STAGE = "Closed - Won";
export const CLOSED_LOST_STAGE = "Closed - Lost";
export const isClosedStage = (s: string): boolean => s === CLOSED_WON_STAGE || s === CLOSED_LOST_STAGE;

// open/won/lost are the pipeline statuses; `archived` parks a test/spam/dead deal
// off the board without polluting the lost analytics.
export const STATUSES = ["open", "won", "lost", "archived"] as const;
export type Status = (typeof STATUSES)[number];

// Preset reasons a deal is marked Lost (from the original spec). "Other" → free text.
export const LOST_REASONS = [
  "Price too high",
  "Budget too low",
  "Out of buyer's price range",
  "Owner won't sell / unreachable",
  "Buyer went cold / no response",
  "Bought / found elsewhere",
  "Changed their mind — didn't move forward",
  "Not a fit",
  "Duplicate",
  "Other",
] as const;

export const PRIORITIES = ["Top", "High", "Normal", "Low"] as const;
export const SOURCES = [
  "Website form", "Inbound email", "Returning client", "Text", "WhatsApp", "Phone", "Referral", "In-person", "Proactive (we're chasing it)",
] as const;

// Budget bands — the same ranges the inquiry form offers, so budget is a sortable/
// searchable value rather than free text. `BUDGET_MAX` is the band ceiling (stored in
// deals.budget_max) so the board/list can sort + filter numerically. $100k+ uses a large
// sentinel so it sorts last.
export const BUDGET_BANDS = ["Under $5k", "$5k–$25k", "$25k–$50k", "$50k–$100k", "$100k+"] as const;
export const BUDGET_MAX: Record<string, number> = {
  "Under $5k": 5000, "$5k–$25k": 25000, "$25k–$50k": 50000, "$50k–$100k": 100000, "$100k+": 100000000,
};

// Map a free-text budget (e.g. an inquiry's "$5K to $25K", "100k+") to a canonical band,
// or null if it can't be read. Used on convert + on write so stored budgets are consistent.
export function normalizeBudget(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/,/g, "").trim();
  if (!s) return null;
  for (const b of BUDGET_BANDS) if (s === b.toLowerCase()) return b;
  if (/\b100\s*k?\s*\+|100\s*k?\s*(plus|or more|and up)|over\s*100|>\s*100/.test(s)) return "$100k+";
  if (/(less than|under|below|up to|<\s*)\s*\$?5\b/.test(s) && !/25|50|100/.test(s)) return "Under $5k";
  const nums: number[] = [];
  const re = /(\d+(?:\.\d+)?)\s*([km])?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) { let n = parseFloat(m[1]); if (m[2] === "k") n *= 1000; else if (m[2] === "m") n *= 1e6; else if (n < 1000) n *= 1000; nums.push(n); }
  if (!nums.length) return null;
  const top = Math.max(...nums);
  if (top <= 5000) return "Under $5k";
  if (top <= 25000) return "$5k–$25k";
  if (top <= 50000) return "$25k–$50k";
  if (top <= 100000) return "$50k–$100k";
  return "$100k+";
}
export function budgetMaxFor(range?: string | null): number | null {
  const band = range && BUDGET_MAX[range] != null ? range : normalizeBudget(range);
  return band ? (BUDGET_MAX[band] ?? null) : null;
}

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}
// A new deal enters at "Assigned" when it has an owner, else the Inbox.
export function entryStage(hasOwner: boolean): Stage {
  return hasOwner ? "Assigned" : "Unassigned / Inbox";
}
