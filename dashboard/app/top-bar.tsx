"use client";

import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { userCan, MODULES, type AppUser } from "@/lib/permissions";
import { TABS } from "./nav";

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

      {/* Desktop: account inline on the right. Hidden on mobile (moves to menu). */}
      <span className="topbar__account">
        <span className="muted">{user.email}</span>
        <a href="/api/logout">Log out</a>
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
