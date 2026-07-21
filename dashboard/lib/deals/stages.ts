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
] as const;
export type Stage = (typeof STAGES)[number];

export const STATUSES = ["open", "won", "lost"] as const;
export type Status = (typeof STATUSES)[number];

export const PRIORITIES = ["Top", "High", "Normal", "Low"] as const;
export const SOURCES = [
  "Website form", "Inbound email", "Text", "WhatsApp", "Phone", "Referral", "In-person", "Proactive (we're chasing it)",
] as const;

export function isStage(s: string): s is Stage {
  return (STAGES as readonly string[]).includes(s);
}
// A new deal enters at "Assigned" when it has an owner, else the Inbox.
export function entryStage(hasOwner: boolean): Stage {
  return hasOwner ? "Assigned" : "Unassigned / Inbox";
}
