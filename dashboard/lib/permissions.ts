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
  first_name?: string | null;
  last_name?: string | null;
}

// Module keys — gate whether a user can ENTER a module.
export const MODULES = [
  "admin", // umbrella — full access to every Admin tab (also = is_admin)
  "admin.sources", // Sources tab (/admin)
  "admin.config", // Configuration tab (/admin/config)
  "admin.schedule", // Schedule tab (/admin/schedule)
  "admin.imports", // the domain import tool (/admin/imports)
  "admin.webflow", // Webflow CMS write — gates editing on Reports → Marketplace Master (+ the /api/admin/webflow write endpoint)
  "reports", // top-level Reports module (/reports) — analytics + cost; NOT under admin
  "research.domain_owner",
  "research.trademark",
  "research.appraisal",
  "research.naming",
  "research.dbscreen",
  "research.dbsearch",
  "research.nameserver",
  "research.sales", // Sales Research Agent — find buyers for a domain we're selling
  "research.beeper", // Beeper — RDAP drop watcher (alert when a domain's status changes)
  "research.whois", // Whois — basic free RDAP/WHOIS domain lookup
  "research.evaluate", // SNAP Eval — should-we-buy-it acquisition/resale scorecard
  "research.bulk_eval", // Bulk Eval — rank a list/CSV of domains by investability (resale vs price)
  "research.expiring", // Expiring .ai — good one-word .ai names entering the redemption window (stored flat as `expiring`)
  "research.snap_research", // SNAP Research — dictionary .com abandonment finder (stored flat as `snap_research`)
  "research.portfolio", // Corporate Portfolios — reverse-WHOIS a company → its premium domains (lives in Reports)
  "research.ahrefs", // Ahrefs Report — website deep-dive (traffic/DR/keywords/backlinks); lives in Reports, stored flat as `ahrefs`
  "research.person", // Person — social-URL deep dive: identity, cross-platform VIP, contacts
  "research.leads", // Inbound-lead triage — the deep-linked dossier for a contact-form inquiry
  "research.pipedrive", // Add-to-Pipedrive — turn a research surface into a buy-side deal (stored flat as `pipedrive`)
  "deals", // Deals — the native buy-side CRM board (see + own deals)
  "snap.deals", // SNAP Deal Board — Sam's lean internal board for names we're trying to ACQUIRE (single view+edit perm)
  "email", // Email — search the deal inbox for a thread + LLM-draft a reply from its context (draft-only)
] as const;
export type ModuleKey = (typeof MODULES)[number];

// Action keys — gate individual actions WITHIN a module.
export const ACTIONS = [
  "research.report_deep", // deep vs shallow report tier
  "research.outreach", // owner-outreach email drafting on a report
  "admin.users.manage", // user + permission administration
  "admin.sources.edit", // edit source registry / schedules
  "admin.lessons.approve", // curate (approve/edit/delete) playbook lessons
  "admin.feedback.manage", // see + manage the whole Feedback / Feature Requests queue (submitting is open to all)
  "admin.imports.replace", // allow the destructive Replace mode in the import tool
  "reports.cost", // view the API cost/usage report + edit rates
  "reports.analytics", // view the Site Analytics (GA4) report
  "reports.marketplace", // view the Marketplace per-domain report (GA4 /domains/*)
  "reports.opportunities", // view the New Opportunities report (snap + auctions)
  "reports.snap_names", // view the SNAP Names report (purchased / for-sale inventory)
  "reports.snap_names.write", // push registrar/DNS updates from SNAP Names (bulk actions)
  "reports.chat", // use Chat Analytics (LLM Q&A over the report data)
  "reports.client_overlap", // view the Client Domain Overlap report (new names matching client domains)
  "reports.social_sweep", // view the Social Sweep report (Reddit/X domain-opportunity posts)
  "reports.content", // view the Content report (Webflow CMS blog posts)
  "reports.email_health", // view the Email Health report (MXToolbox deliverability checks)
  "reports.seo", // view the SEO report (high-intent keyword rank tracking + weekly loop)
  "deals.all", // see + manage EVERYONE's deals (else a user sees strictly their own)
  "deals.inbox", // additionally see the unassigned Inbox (claim new/unassigned deals)
  "deals.assignable", // "can receive deals" — appears in the assignee dropdowns
  "deals.reports", // the Deals Reporting view — query/aggregate across ALL deals
  "deals.sam_split", // can toggle the "Sam splits upfront" flag on a deal (Rob/Judy/Brian)
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
  { href: "/research/admin", label: "Lessons", perm: "admin.lessons.approve" },
];

// The Reports module's sub-nav — its own top-level module (peer to Admin), so
// analytics access can be granted WITHOUT admin powers. `reports` umbrella (and
// is_admin) grant both; otherwise the specific action is needed.
export const REPORTS_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  { href: "/reports", label: "Site analytics", perm: "reports.analytics" },
  { href: "/reports/marketplace", label: "Marketplace Reports", perm: "reports.marketplace" },
  // Marketplace CMS — the Webflow CMS listings (pull + edit).
  { href: "/reports/marketplace-master", label: "Marketplace CMS", perm: "reports.marketplace" },
  { href: "/reports/chat", label: "Chat", perm: "reports.chat" },
  { href: "/reports/cost", label: "Cost & usage", perm: "reports.cost" },
  { href: "/reports/client-overlap", label: "Client Overlap", perm: "reports.client_overlap" },
  { href: "/reports/social-sweep", label: "Social Sweep", perm: "reports.social_sweep" },
  // Content — blog posts pulled from the Webflow CMS (read-only).
  { href: "/reports/content", label: "Content", perm: "reports.content" },
  { href: "/reports/email-health", label: "Email Health", perm: "reports.email_health" },
  { href: "/reports/seo", label: "SEO", perm: "reports.seo" },
  // Corporate Portfolios lives in the research app (/research/portfolio) but
  // belongs to the Reports section. Nav renders /research/* as a full-nav anchor.
  { href: "/research/portfolio", label: "Corporate Portfolios", perm: "research.portfolio" },
  // Ahrefs Report — a website deep-dive (traffic/DR/keywords/backlinks) in the research app.
  { href: "/research/ahrefs", label: "Ahrefs Report", perm: "research.ahrefs" },
];

// The Research section's hub/menu entries (the research app serves each page).
// This is the curated entry list (the research SPA has its own full tool sub-nav).
export const RESEARCH_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  { href: "/research", label: "Domain Owner", perm: "research.domain_owner" },
  { href: "/research/trademark", label: "Trademark", perm: "research.trademark" },
  { href: "/research/appraisal", label: "Appraisal", perm: "research.appraisal" },
  { href: "/research/naming", label: "Naming Exercise", perm: "research.naming" },
  { href: "/research/dbscreen", label: "Domain DB Screen", perm: "research.dbscreen" },
  { href: "/research/dbsearch", label: "Domain Name Search", perm: "research.dbsearch" },
  { href: "/research/nameserver", label: "Nameserver Search", perm: "research.nameserver" },
  { href: "/research/sales", label: "Sales Research", perm: "research.sales" },
  { href: "/research/person", label: "Person (deep dive)", perm: "research.person" },
  { href: "/research/beeper", label: "Beeper (drop watch)", perm: "research.beeper" },
  { href: "/research/whois", label: "Whois (domain lookup)", perm: "research.whois" },
];

// Deals — the native buy-side CRM (its own top-level module). The board is the home;
// deal detail lives at /deals/<id>. Gated by the `deals` module (deals.all sees everyone's).
export const DEALS_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  // Personal to-do list — replies owed, new assignments, boomerangs, deals shared with you.
  // The default landing tab (see SECTIONS.deals.href in navigation.ts).
  { href: "/deals/tasks", label: "My Tasks", perm: "deals" },
  { href: "/deals", label: "Board", perm: "deals" },
  { href: "/deals/list", label: "List", perm: "deals" },
  // Owner intelligence directory — every domain owner we work with + negotiation history.
  { href: "/deals/owners", label: "Owners", perm: "deals" },
  // Owner Review queue — confirm the "owner we bought from" for each closed Master Txn.
  { href: "/deals/owner-review", label: "Owner Review", perm: "deals" },
  // Buy-side inquiry triage → deals. Gated by research.pipedrive (canTab → userCan).
  { href: "/deals/inquiries", label: "Buy-Side Inquiries", perm: "research.pipedrive" },
  { href: "/deals/reports", label: "Reporting", perm: "deals.reports" },
];

// Email — a standalone top-level module: search the deal inbox for a thread and LLM-draft a
// reply from its context (draft-only). Single page; gated by the `email` module perm.
export const EMAIL_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  { href: "/email", label: "Compose", perm: "email" },
  { href: "/email/load", label: "Inbox load", perm: "email" },
];

// Tools — a top-level section that CONSOLIDATES Reports + Email into one SNAP-style sub-nav
// (Rob, 2026-09-03: no dropdown; one header item whose sub-modules mirror SNAP's layout). The
// section's tabs are the Reports pages + the Email pages, flattened into one row (wraps like the
// Research sub-nav). REPORTS_TABS/EMAIL_TABS stay defined for the per-perm helpers + gates.
export const TOOLS_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  ...REPORTS_TABS,
  ...EMAIL_TABS,
];

// SNAP — its own top-level workspace (peer to Research/Admin/Reports). Two tools,
// each served by a different app: SNAP Eval (the research app) + SNAP Opportunities
// (the auctions/snap feed, page still at /reports/opportunities). This drives the
// SNAP section sub-nav in both the umbrella TopBar and the research SPA.
export const SNAP_TABS: { href: string; label: string; perm: ModuleKey | ActionKey }[] = [
  { href: "/research/evaluate", label: "SNAP Eval", perm: "research.evaluate" },
  { href: "/research/bulk-eval", label: "Bulk Eval", perm: "research.bulk_eval" },
  { href: "/research/expiring", label: "Expiring .ai", perm: "research.expiring" },
  { href: "/reports/opportunities", label: "SNAP Opportunities", perm: "reports.opportunities" },
  { href: "/reports/snap-names", label: "SNAP Names", perm: "reports.snap_names" },
  { href: "/research/snap-research", label: "SNAP Research", perm: "research.snap_research" },
  { href: "/snap-deals", label: "SNAP Deal Board", perm: "snap.deals" },
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

// Reports is its OWN top-level module — deliberately independent of the `admin`
// umbrella so you can grant analytics without admin powers. is_admin still
// auto-passes (owner break-glass).
export function canReports(user: AppUser | null, key: ModuleKey | ActionKey): boolean {
  if (!user) return false;
  return user.is_admin || isGranted(user.permissions, "reports") || isGranted(user.permissions, key);
}
// Deals is its own top-level module (no umbrella) — enter iff the deals module (or the
// deals.all action, or is_admin) is granted.
export function canEnterDeals(user: AppUser | null): boolean {
  if (!user) return false;
  // research.pipedrive admits the Buy-Side Inquiries triage tab (which now lives here).
  return user.is_admin || isGranted(user.permissions, "deals") || isGranted(user.permissions, "deals.all") || isGranted(user.permissions, "research.pipedrive");
}
export function canEnterReports(user: AppUser | null): boolean {
  if (!user) return false;
  if (user.is_admin || isGranted(user.permissions, "reports")) return true;
  // SNAP Opportunities' page lives under /reports/* but is no longer a Reports tab,
  // so admit a user who only holds reports.opportunities too.
  if (isGranted(user.permissions, "reports.opportunities")) return true;
  if (isGranted(user.permissions, "reports.snap_names")) return true;
  return REPORTS_TABS.some((t) => isGranted(user.permissions, t.perm));
}

// Tools section = Reports ∪ Email. Enterable if the user can enter Reports OR has an Email tab.
export function canEnterTools(user: AppUser | null): boolean {
  if (!user) return false;
  if (canEnterReports(user)) return true;
  return EMAIL_TABS.some((t) => isGranted(user.permissions, t.perm));
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
  { key: "admin.webflow", label: "Marketplace Master — edit listings (Webflow CMS write)", group: "Reports", kind: "module" },
  { key: "admin.lessons.approve", label: "Lessons — curate / approve", group: "Admin", kind: "action" },
  { key: "admin.feedback.manage", label: "Feedback — manage the feature-request queue", group: "Admin", kind: "action" },
  { key: "reports", label: "Reports — full access (analytics + cost)", group: "Reports", kind: "module" },
  { key: "reports.analytics", label: "Reports — Site Analytics", group: "Reports", kind: "action" },
  { key: "reports.marketplace", label: "Reports — Marketplace (per-domain)", group: "Reports", kind: "action" },
  { key: "research.evaluate", label: "SNAP Eval (acquisition / resale scorecard)", group: "SNAP", kind: "module" },
  { key: "research.bulk_eval", label: "Bulk Eval (rank a list of domains by investability)", group: "SNAP", kind: "module" },
  { key: "research.expiring", label: "Expiring .ai (one-word .ai names entering redemption)", group: "SNAP", kind: "module" },
  { key: "snap.deals", label: "SNAP Deal Board (view + edit — internal acquisition tracker)", group: "SNAP", kind: "module" },
  { key: "research.snap_research", label: "SNAP Research (dictionary .com abandonment finder)", group: "SNAP", kind: "module" },
  { key: "reports.opportunities", label: "SNAP Opportunities (snap + auctions)", group: "SNAP", kind: "action" },
  { key: "reports.snap_names", label: "SNAP Names (purchased / for-sale inventory)", group: "SNAP", kind: "action" },
  { key: "reports.snap_names.write", label: "SNAP Names — push registrar/DNS updates (bulk)", group: "SNAP", kind: "action" },
  { key: "reports.chat", label: "Reports — Chat Analytics (LLM Q&A)", group: "Reports", kind: "action" },
  { key: "reports.cost", label: "Reports — API cost & usage", group: "Reports", kind: "action" },
  { key: "reports.client_overlap", label: "Reports — Client Domain Overlap (new names matching client domains)", group: "Reports", kind: "action" },
  { key: "reports.social_sweep", label: "Reports — Social Sweep (Reddit/X domain-opportunity posts)", group: "Reports", kind: "action" },
  { key: "reports.content", label: "Reports — Content (blog posts from Webflow CMS)", group: "Reports", kind: "action" },
  { key: "reports.email_health", label: "Reports — Email Health (MXToolbox deliverability)", group: "Reports", kind: "action" },
  { key: "reports.seo", label: "Reports — SEO (keyword rank tracking + weekly action loop)", group: "Reports", kind: "action" },
  { key: "research.domain_owner", label: "Domain Owner research", group: "Research", kind: "module" },
  { key: "research.outreach", label: "Owner Outreach — email drafting", group: "Research", kind: "action" },
  { key: "research.trademark", label: "Trademark", group: "Research", kind: "module" },
  { key: "research.appraisal", label: "Appraisal", group: "Research", kind: "module" },
  { key: "research.naming", label: "Naming Exercise — Free Reports", group: "Research", kind: "module" },
  { key: "research.report_deep", label: "Naming Exercise — Deep Research", group: "Research", kind: "action" },
  { key: "research.dbscreen", label: "Domain DB Screen", group: "Research", kind: "module" },
  { key: "research.dbsearch", label: "Domain Name Search", group: "Research", kind: "module" },
  { key: "research.nameserver", label: "Nameserver Search", group: "Research", kind: "module" },
  { key: "research.sales", label: "Sales Research", group: "Research", kind: "module" },
  { key: "research.person", label: "Person (deep dive)", group: "Research", kind: "module" },
  { key: "research.leads", label: "Inbound Lead Triage", group: "Research", kind: "module" },
  { key: "research.pipedrive", label: "Add to Pipedrive (buy-side deal)", group: "Research", kind: "module" },
  { key: "research.beeper", label: "Beeper (drop watch)", group: "Research", kind: "module" },
  { key: "research.whois", label: "Whois (domain lookup)", group: "Research", kind: "module" },
  { key: "research.portfolio", label: "Corporate Portfolios", group: "Reports", kind: "module" },
  { key: "research.ahrefs", label: "Ahrefs Report (website deep-dive)", group: "Reports", kind: "module" },
  { key: "deals", label: "Deals — buy-side CRM board (your own deals)", group: "Deals", kind: "module" },
  { key: "deals.all", label: "Deals — see everyone's deals", group: "Deals", kind: "action" },
  { key: "deals.inbox", label: "Deals — see the unassigned Inbox", group: "Deals", kind: "action" },
  { key: "deals.assignable", label: "Deals — can receive deals (shows in assignee lists)", group: "Deals", kind: "action" },
  { key: "deals.reports", label: "Deals — Reporting (query/aggregate all deals)", group: "Deals", kind: "action" },
  { key: "deals.sam_split", label: "Deals — toggle 'Sam splits upfront' on a deal", group: "Deals", kind: "action" },
  { key: "email", label: "Email — search the inbox + LLM-draft a reply (draft-only)", group: "Email", kind: "module" },
];
