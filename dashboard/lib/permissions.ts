// The shared permission catalog and the two-tier (module + action) checks.
//
// This is the CONTRACT both apps agree on. Research keeps an equivalent copy;
// keep the key sets in sync. It is data, not logic — adding a new module is a
// one-line addition here (and in research).
//
// Storage: the `permissions` JSONB column on domain_research_users. `is_admin`
// auto-passes every check.

export interface AppUser {
  id: string;
  email: string;
  is_admin: boolean;
  permissions: Record<string, unknown>;
}

// Module keys — gate whether a user can ENTER a module.
export const MODULES = [
  "admin", // the pipeline dashboard (this repo)
  "research.domain_owner",
  "research.trademark",
  "research.appraisal",
  "research.naming",
] as const;
export type ModuleKey = (typeof MODULES)[number];

// Action keys — gate individual actions WITHIN a module.
export const ACTIONS = [
  "research.report_deep", // deep vs shallow report tier
  "admin.users.manage", // user + permission administration
  "admin.sources.edit", // edit source registry / schedules
] as const;
export type ActionKey = (typeof ACTIONS)[number];

// Legacy flat keys research stores today: domain_owner, trademark, appraisal,
// naming, report_deep, report_shallow. A namespaced "research.<x>" key falls
// back to the flat "<x>" key so existing rows keep working unchanged.
function permGranted(perms: Record<string, unknown>, key: string): boolean {
  if (!perms) return false;
  if (perms[key] === true) return true;
  if (key.startsWith("research.")) {
    const flat = key.slice("research.".length);
    if (perms[flat] === true) return true;
  }
  return false;
}

export function userCan(user: AppUser | null, moduleKey: ModuleKey): boolean {
  if (!user) return false;
  return user.is_admin || permGranted(user.permissions, moduleKey);
}

export function userCanAction(user: AppUser | null, actionKey: ActionKey): boolean {
  if (!user) return false;
  return user.is_admin || permGranted(user.permissions, actionKey);
}
