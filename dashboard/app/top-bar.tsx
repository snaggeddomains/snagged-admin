"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { userCan, MODULES, canEnterAdmin, canAdmin, ADMIN_TABS, canEnterReports, canReports, REPORTS_TABS, type AppUser } from "@/lib/permissions";
import NotificationsBell from "./notifications-bell";

// The global chrome shared across every umbrella surface (hub, admin) and
// mirrored by research. Logo -> hub, permission-aware module switcher, account.
// On mobile the account (and, in Admin, the section tabs) collapse into a
// top-right hamburger menu so the bar matches the Research module exactly.
export default function TopBar({
  user,
  current,
}: {
  user: AppUser;
  current?: "research" | "admin" | "reports";
}) {
  const canResearch = MODULES.some((m) => m.startsWith("research.") && userCan(user, m));
  const adminAccess = canEnterAdmin(user);
  const reportsAccess = canEnterReports(user);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // The active module's section tabs live in the hamburger on mobile (.tab-nav is
  // hidden there). Both Admin and Reports drive it from their own tab lists.
  const menuTabs =
    current === "admin" ? ADMIN_TABS.filter((t) => canAdmin(user, t.perm))
      : current === "reports" ? REPORTS_TABS.filter((t) => canReports(user, t.perm))
        : [];

  return (
    <header className="topbar">
      <Link href="/" className="topbar__brand wordmark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
        <span className="wm-a">Snagged</span>
      </Link>

      {(canResearch || adminAccess || reportsAccess) && (
        <nav className="topbar__nav">
          {canResearch && (
            <a href="/research" className={current === "research" ? "active" : ""}>
              Research
            </a>
          )}
          {adminAccess && (
            <Link href="/admin" className={current === "admin" ? "active" : ""}>
              Admin
            </Link>
          )}
          {reportsAccess && (
            <Link href="/reports" className={current === "reports" ? "active" : ""}>
              Reports
            </Link>
          )}
        </nav>
      )}

      {/* In-app back/refresh — only render in the installed PWA (standalone), where
          there's no browser chrome. Mirrors the Research app so Admin doesn't feel
          like a trapped page. Shows on mobile too (outside the desktop-only account
          span), pinned just left of the hamburger. */}
      <PwaNavControls />

      {/* Desktop: bell + account avatar on the right (mirrors Research). Hidden
          on mobile (moves to the hamburger menu). */}
      <span className="topbar__account" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <NotificationsBell />
        <span className="topbar__avatar"><AccountAvatar email={user.email} /></span>
      </span>

      {/* Mobile-only hamburger, pinned top-right. */}
      <button
        type="button"
        className="topbar__burger"
        aria-label="Menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        &#9776;
      </button>

      {/* Mobile dropdown: the active module's section tabs (if any) + account. */}
      <div className={"topbar__menu" + (open ? " open" : "")}>
        {menuTabs.length > 0 && (
          <nav className="topbar__menu-nav">
            {menuTabs.map((t) => {
              const isIndex = t.href === "/admin" || t.href === "/reports";
              const active = isIndex ? pathname === t.href : pathname.startsWith(t.href);
              return (
                <Link
                  key={t.href}
                  href={t.href}
                  className={active ? "active" : ""}
                  onClick={() => setOpen(false)}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        )}
        <div className="topbar__menu-account">
          <span className="muted">{user.email}</span>
          <a href="/api/logout">Log out</a>
        </div>
      </div>
    </header>
  );
}

// Back + refresh buttons shown only when running as an installed PWA (iOS
// `navigator.standalone` or the standalone display-mode media query). In that mode
// there's no Safari chrome, so without these Admin feels like a dead-end page —
// Research has the same affordance. Hidden in a normal browser tab (it already has
// back/refresh).
function PwaNavControls() {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(display-mode: standalone)") : null;
    const check = () => setStandalone(
      Boolean(mq?.matches) || (window.navigator as unknown as { standalone?: boolean }).standalone === true,
    );
    check();
    mq?.addEventListener?.("change", check);
    return () => mq?.removeEventListener?.("change", check);
  }, []);
  if (!standalone) return null;
  const btn: React.CSSProperties = {
    width: 34, height: 34, borderRadius: "50%", border: "none", background: "transparent",
    color: "var(--navy, #254254)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  return (
    <span className="topbar__pwa-nav" style={{ display: "inline-flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
      <button type="button" aria-label="Back" title="Back" onClick={() => window.history.back()} style={btn}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <button type="button" aria-label="Refresh" title="Refresh" onClick={() => window.location.reload()} style={btn}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
      </button>
    </span>
  );
}

// Profile avatar + dropdown, matching the Research module's account chip: a
// round initial badge that opens email + account links + Log out.
function AccountAvatar({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const initial = (email || "?").trim().charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account"
        style={{
          width: 34, height: 34, borderRadius: "50%", border: "none", cursor: "pointer",
          background: "linear-gradient(160deg,#3a7ca5,#2a6f97)", color: "#fff",
          fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
        }}
      >
        {initial}
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 8px)", right: 0, width: 240,
          background: "#fff", border: "1px solid var(--line, #e3ddcf)", borderRadius: 12,
          boxShadow: "0 10px 30px rgba(37,66,84,.18)", zIndex: 50, overflow: "hidden",
        }}>
          <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--line, #efe9dc)" }}>
            <div className="muted" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".04em" }}>Signed in as</div>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--navy)", wordBreak: "break-all" }}>{email}</div>
          </div>
          <a href="/research" style={menuLink}>Research profile &amp; settings</a>
          <a href="/api/logout" style={{ ...menuLink, color: "var(--coral-deep, #c75f45)", borderBottom: "none" }}>Log out</a>
        </div>
      )}
    </div>
  );
}

const menuLink: React.CSSProperties = {
  display: "block", padding: "10px 14px", fontSize: 13, color: "var(--navy)",
  textDecoration: "none", borderBottom: "1px solid var(--line, #f1ece0)",
};
