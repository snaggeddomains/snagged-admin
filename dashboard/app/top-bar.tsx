"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { userCan, MODULES, type AppUser } from "@/lib/permissions";
import { TABS } from "./nav";
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
  current?: "research" | "admin";
}) {
  const canResearch = MODULES.some((m) => m.startsWith("research.") && userCan(user, m));
  const canAdmin = userCan(user, "admin");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const showTabs = current === "admin"; // admin section tabs live in the menu on mobile

  return (
    <header className="topbar">
      <Link href="/" className="topbar__brand wordmark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
        <span className="wm-a">Snagged</span>
      </Link>

      {(canResearch || canAdmin) && (
        <nav className="topbar__nav">
          {canResearch && (
            <a href="/research" className={current === "research" ? "active" : ""}>
              Research
            </a>
          )}
          {canAdmin && (
            <Link href="/admin" className={current === "admin" ? "active" : ""}>
              Admin
            </Link>
          )}
        </nav>
      )}

      {/* Desktop: bell + account avatar on the right (mirrors Research). Hidden
          on mobile (moves to the hamburger menu). */}
      <span className="topbar__account" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <NotificationsBell />
        <AccountAvatar email={user.email} />
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

      {/* Mobile dropdown: admin section tabs (if any) + account. */}
      <div className={"topbar__menu" + (open ? " open" : "")}>
        {showTabs && (
          <nav className="topbar__menu-nav">
            {TABS.map((t) => {
              const active =
                t.href === "/admin" ? pathname === "/admin" : pathname.startsWith(t.href);
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
