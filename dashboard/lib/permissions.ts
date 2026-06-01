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
  "research.dbscreen",
  "research.dbsearch",
] as const;
export type ModuleKey = (typeof MODULES)[number];

// Action keys — gate individual actions WITHIN a module.
export const ACTIONS = [
  "research.report_deep", // deep vs shallow report tier
  "admin.users.manage", // user + permission administration
  "admin.sources.edit", // edit source registry / schedules
] as const;
export type ActionKey = (typeof ACTIONS)[number];

// The key as it is STORED in the permissions JSONB. Research reads flat keys
// today (domain_owner, trademark, …), so a "research.<x>" catalog key maps to
// the flat "<x>" on disk; umbrella-only keys (admin*) store as-is. This is the
// single mapping used by both reads (isGranted) and writes (the editor), so the
// two never diverge — and existing research rows keep working unchanged.
export function storageKey(key: string): string {
  return key.startsWith("research.") ? key.slice("research.".length) : key;
}

export function isGranted(perms: Record<string, unknown>, key: string): boolean {
  if (!perms) return false;
  return perms[key] === true || perms[storageKey(key)] === true;
}

export function userCan(user: AppUser | null, moduleKey: ModuleKey): boolean {
  if (!user) return false;
  return user.is_admin || isGranted(user.permissions, moduleKey);
}

export function userCanAction(user: AppUser | null, actionKey: ActionKey): boolean {
  if (!user) return false;
  return user.is_admin || isGranted(user.permissions, actionKey);
}

// UI descriptor for the /admin/users permission editor. Adding a future module
// is a one-line addition here (kept in sync with MODULES/ACTIONS above).
export interface CatalogEntry {
  key: ModuleKey | ActionKey;
  label: string;
  group: string;
  kind: "module" | "action";
}

export const CATALOG: CatalogEntry[] = [
  { key: "admin", label: "Admin dashboard", group: "Admin", kind: "module" },
  { key: "admin.users.manage", label: "Manage users & permissions", group: "Admin", kind: "action" },
  { key: "admin.sources.edit", label: "Edit sources & schedules", group: "Admin", kind: "action" },
  { key: "research.domain_owner", label: "Domain Owner research", group: "Research", kind: "module" },
  { key: "research.trademark", label: "Trademark", group: "Research", kind: "module" },
  { key: "research.appraisal", label: "Appraisal", group: "Research", kind: "module" },
  { key: "research.naming", label: "Naming Exercise — Free Reports", group: "Research", kind: "module" },
  { key: "research.report_deep", label: "Naming Exercise — Deep Research", group: "Research", kind: "action" },
  { key: "research.dbscreen", label: "Domain DB Screen", group: "Research", kind: "module" },
  { key: "research.dbsearch", label: "DB Search", group: "Research", kind: "module" },
];
