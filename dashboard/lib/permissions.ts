// The shared permission catalog and the two-tier (module + action) checks.
//
// This is the CONTRACT both apps agree on. Research keeps an equivalent copy;
// keep the key sets in sync. It is data, not logic — adding a new module is a
// one-line addition here (and in research).
//
// Storage: the `permissions` JSONB column on domain_research_users. `is_admin`
// auto-passes every check.
//
// CONVENTION: `is_admin` is the OWNER / break-glass superuser — reserve it for
// the owner account(s) only (it inherits every current + future module/action
// and can never be locked out of the user editor). Everyone else, including
// power users, gets GRANULAR module/action grants below — do not hand out
// is_admin for convenience.

export interface AppUser {
  id: string;
  email: string;
  is_admin: boolean;
  permissions: Record<string, unknown>;
}

// Module keys — gate whether a user can ENTER a module.
export const MODULES = [
  "admin", // umbrella — full access to every Admin tab (also = is_admin)
  "admin.sources", // Sources tab (/admin)
  "admin.config", // Configuration tab (/admin/config)
  "admin.schedule", // Schedule tab (/admin/schedule)
  "admin.imports", // the domain import tool (/admin/imports)
  "admin.reports", // the Reports tab (/admin/reports) — usage/cost dashboards
  "research.domain_owner",
  "research.trademark",
  "research.appraisal",
  "research.naming",
  "research.dbscreen",
  "research.dbsearch",
  "research.nameserver",
] as const;
export type ModuleKey = (typeof MODULES)[number];

// Action keys — gate individual actions WITHIN a module.
export const ACTIONS = [
  "research.report_deep", // deep vs shallow report tier
  "research.outreach", // owner-outreach email drafting on a report
  "admin.users.manage", // user + permission administration
  "admin.sources.edit", // edit source registry / schedules
  "admin.lessons.approve", // curate (approve/edit/delete) playbook lessons
  "admin.imports.replace", // allow the destructive Replace mode in the import tool
  "admin.reports.cost", // view the API cost/usage report + edit rates
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

// The Admin sub-nav — the SINGLE source of truth for the tabs AND each tab's
// gating permission. Every admin tab is independently grantable at the user
// level; the `admin` umbrella (and is_admin) grants them all.
//
// FORWARD RULE: any new module/tool we add MUST have its own granular,
// user-settable permission here (and in the CATALOG below) — never gate a new
// surface on is_admin or the coarse `admin` umbrella alone.
export const ADMIN_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  { href: "/admin", label: "Sources", perm: "admin.sources" },
  { href: "/admin/config", label: "Configuration", perm: "admin.config" },
  { href: "/admin/schedule", label: "Schedule", perm: "admin.schedule" },
  { href: "/admin/users", label: "Users", perm: "admin.users.manage" },
  { href: "/admin/imports", label: "Imports", perm: "admin.imports" },
  { href: "/admin/reports", label: "Reports", perm: "admin.reports" },
  { href: "/research/admin", label: "Lessons", perm: "admin.lessons.approve" },
];

// Can the user use this admin tab/key? is_admin and the `admin` umbrella both
// grant every tab; otherwise the specific key must be granted.
export function canAdmin(user: AppUser | null, key: ModuleKey | ActionKey): boolean {
  if (!user) return false;
  return user.is_admin || isGranted(user.permissions, "admin") || isGranted(user.permissions, key);
}

// Can the user open the Admin area at all (umbrella, or any individual tab)?
export function canEnterAdmin(user: AppUser | null): boolean {
  if (!user) return false;
  if (user.is_admin || isGranted(user.permissions, "admin")) return true;
  return ADMIN_TABS.some((t) => isGranted(user.permissions, t.perm));
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
  { key: "admin", label: "Admin — full access (all tabs)", group: "Admin", kind: "module" },
  { key: "admin.sources", label: "Sources", group: "Admin", kind: "module" },
  { key: "admin.sources.edit", label: "Sources — edit registry / schedules", group: "Admin", kind: "action" },
  { key: "admin.config", label: "Configuration", group: "Admin", kind: "module" },
  { key: "admin.schedule", label: "Schedule", group: "Admin", kind: "module" },
  { key: "admin.users.manage", label: "Users — manage users & permissions", group: "Admin", kind: "action" },
  { key: "admin.imports", label: "Imports", group: "Admin", kind: "module" },
  { key: "admin.imports.replace", label: "Imports — Replace mode (destructive)", group: "Admin", kind: "action" },
  { key: "admin.reports", label: "Reports", group: "Admin", kind: "module" },
  { key: "admin.reports.cost", label: "Reports — API cost & usage", group: "Admin", kind: "action" },
  { key: "admin.lessons.approve", label: "Lessons — curate / approve", group: "Admin", kind: "action" },
  { key: "research.domain_owner", label: "Domain Owner research", group: "Research", kind: "module" },
  { key: "research.outreach", label: "Owner Outreach — email drafting", group: "Research", kind: "action" },
  { key: "research.trademark", label: "Trademark", group: "Research", kind: "module" },
  { key: "research.appraisal", label: "Appraisal", group: "Research", kind: "module" },
  { key: "research.naming", label: "Naming Exercise — Free Reports", group: "Research", kind: "module" },
  { key: "research.report_deep", label: "Naming Exercise — Deep Research", group: "Research", kind: "action" },
  { key: "research.dbscreen", label: "Domain DB Screen", group: "Research", kind: "module" },
  { key: "research.dbsearch", label: "Domain Name Search", group: "Research", kind: "module" },
  { key: "research.nameserver", label: "Nameserver Search", group: "Research", kind: "module" },
];
