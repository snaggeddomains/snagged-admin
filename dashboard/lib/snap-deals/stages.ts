// SNAP Deals pipeline definition — the board columns, in order. A lean internal tracker
// for names SNAP is trying to acquire (Sam runs point). No Inbox/Assigned — a deal starts
// in Qualifying. "Closed - Won" is the one terminal COLUMN; "Dropped" is a terminal STATUS
// applied via the board's bottom drop-zone (keeps its working stage + a DROPPED badge).

export const STAGES = [
  "Qualifying",
  "Research & Outreach",
  "In Contact",
  "Negotiating",
  "Transaction",
  "Closed - Won",
] as const;
export type Stage = (typeof STAGES)[number];

export const CLOSED_WON_STAGE = "Closed - Won";
export const ENTRY_STAGE: Stage = "Qualifying";

// open = active on the board · won = acquired (Closed - Won column) · dropped = we passed.
export const STATUSES = ["open", "won", "dropped"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABELS: Record<string, string> = {
  open: "Open", won: "Won", dropped: "Dropped", all: "All",
};
export const statusLabel = (s: string): string => STATUS_LABELS[s] || s;

// Reasons we passed on a name — the bottom "Dropped" drop-zone picker. "Other" → free text.
export const DROP_REASONS = [
  "Too expensive",
  "Owner won't sell / unreachable",
  "Not worth pursuing",
  "Went cold",
  "Acquired elsewhere / gone",
  "Changed our mind",
  "Other",
] as const;

export const PRIORITIES = ["Top", "High", "Normal", "Low"] as const;
export const PRIORITY_RANK: Record<string, number> = { Top: 0, High: 1, Normal: 2, Low: 3 };

export function isValidStage(s: unknown): s is Stage {
  return typeof s === "string" && (STAGES as readonly string[]).includes(s);
}
export function isValidStatus(s: unknown): s is Status {
  return typeof s === "string" && (STATUSES as readonly string[]).includes(s);
}
