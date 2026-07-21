// Navigation registry — the SINGLE source of truth for the app's menu structure.
// Every menu surface derives from SECTIONS: the hub cards (app/page.tsx), the top
// header + mobile menu (app/top-bar.tsx), and the per-section sub-nav chrome
// (app/section-chrome.tsx, used by the admin + reports layouts).
//
// ── How to add a top-level section ──────────────────────────────────────────
//   1. Add its tab list to lib/permissions.ts (or reuse an existing one) and any
//      new permission keys to MODULES/ACTIONS + CATALOG.
//   2. Add one NavSection entry to SECTIONS below.
//   That's it — the hub card, header item, mobile menu, and sub-nav all appear.
//
// ── How to add a tab to a section ───────────────────────────────────────────
//   Add one row to that section's tab list in lib/permissions.ts (RESEARCH_TABS /
//   ADMIN_TABS / SNAP_TABS / REPORTS_TABS). A tab whose href starts with
//   "/research" is served by the research app and is rendered as a full-nav link.
//
// A page can live in a DIFFERENT app than its section (e.g. SNAP Opportunities is
// at /reports/opportunities; Corporate Portfolios is at /research/portfolio) —
// section membership is by which tab list it's in, and `sectionForPath` resolves
// the current section from the URL accordingly.

import {
  type AppUser,
  type ModuleKey,
  type ActionKey,
  MODULES,
  userCan,
  userCanAction,
  canAdmin,
  canReports,
  canEnterAdmin,
  canEnterReports,
  RESEARCH_TABS,
  ADMIN_TABS,
  SNAP_TABS,
  REPORTS_TABS,
  DEALS_TABS,
  canEnterDeals,
} from "./permissions";

export type NavTab = { href: string; label: string; perm: ModuleKey | ActionKey };
export type SectionKey = "research" | "admin" | "snap" | "reports" | "deals";

export type NavSection = {
  key: SectionKey;
  label: string;
  href: string; // top-level link target (the section's "home")
  blurb: string; // hub card description
  tabs: NavTab[]; // sub-nav + hub-card tasks (gated per-tab)
};

// Order here = order in the top header AND the hub: Research, Admin, SNAP, Reports.
export const SECTIONS: NavSection[] = [
  {
    key: "research",
    label: "Research",
    href: "/research",
    blurb: "Domain ownership, trademark, appraisal & naming research.",
    tabs: RESEARCH_TABS,
  },
  {
    key: "admin",
    label: "Admin",
    href: "/admin",
    blurb: "Marketplace pipeline dashboard — sources, schedule, configuration & users.",
    tabs: ADMIN_TABS,
  },
  {
    key: "snap",
    label: "SNAP",
    href: "/research/evaluate",
    blurb: "Should we buy it? Acquisition/resale scoring & the live opportunity feed.",
    tabs: SNAP_TABS,
  },
  {
    key: "reports",
    label: "Reports",
    href: "/reports",
    blurb: "Site analytics, SEO, revenue & API cost — plus corporate portfolios.",
    tabs: REPORTS_TABS,
  },
  {
    key: "deals",
    label: "Deals",
    href: "/deals",
    blurb: "Buy-side CRM — the deal board, ownership, notes & email ingestion.",
    tabs: DEALS_TABS,
  },
];

const MODULE_SET = new Set<string>(MODULES as readonly string[]);

// Per-tab gate, routed to the right umbrella-aware check by the key's namespace:
//   admin.*   → canAdmin   (admin umbrella + is_admin auto-pass)
//   reports.* → canReports (reports umbrella + is_admin auto-pass)
//   research.* → userCan / userCanAction (no umbrella beyond is_admin)
export function canTab(user: AppUser | null, perm: ModuleKey | ActionKey): boolean {
  if (perm.startsWith("admin")) return canAdmin(user, perm);
  if (perm.startsWith("reports")) return canReports(user, perm);
  return MODULE_SET.has(perm) ? userCan(user, perm as ModuleKey) : userCanAction(user, perm as ActionKey);
}

// The tabs a user may actually open within a section.
export function sectionTabs(user: AppUser | null, key: SectionKey): NavTab[] {
  const section = SECTIONS.find((s) => s.key === key);
  if (!section) return [];
  return section.tabs.filter((t) => canTab(user, t.perm));
}

// Admin and Reports have an umbrella that admits the section even with no single
// tab granted; Research and SNAP are enterable iff at least one tab is allowed.
export function canEnterSection(user: AppUser | null, key: SectionKey): boolean {
  if (key === "admin") return canEnterAdmin(user);
  if (key === "reports") return canEnterReports(user);
  if (key === "deals") return canEnterDeals(user);
  return sectionTabs(user, key).length > 0;
}

// The sections this user can see, in registry order — drives the header + hub.
export function visibleSections(user: AppUser | null): NavSection[] {
  return SECTIONS.filter((s) => canEnterSection(user, s.key));
}

// Resolve which section a path belongs to — the tab whose href is the LONGEST
// prefix of the path wins (so /reports/opportunities → SNAP, /research/portfolio →
// Reports, /research/evaluate → SNAP, everything else under /research → Research).
// Index hrefs (/research, /admin, /reports) match only exactly.
export function sectionForPath(pathname: string): SectionKey {
  let best: { len: number; key: SectionKey } | null = null;
  for (const s of SECTIONS) {
    for (const t of s.tabs) {
      const href = t.href;
      const isIndex = href === "/research" || href === "/admin" || href === "/reports";
      const match = isIndex ? pathname === href : pathname === href || pathname.startsWith(href + "/") || pathname.startsWith(href);
      if (match && (!best || href.length > best.len)) best = { len: href.length, key: s.key };
    }
  }
  return best ? best.key : "research";
}
