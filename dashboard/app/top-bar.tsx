"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { type AppUser } from "@/lib/permissions";
import { visibleSections, sectionTabs, type SectionKey } from "@/lib/navigation";
import NotificationsBell from "./notifications-bell";
import CommandPalette from "./command-palette";

// The global chrome shared across every umbrella surface (hub, admin) and
// mirrored by research. Logo -> hub, permission-aware module switcher, account.
// On mobile the account (and, in Admin, the section tabs) collapse into a
// top-right hamburger menu so the bar matches the Research module exactly.
export default function TopBar({
  user,
  current,
}: {
  user: AppUser;
  current?: SectionKey;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  // Everything below is derived from the navigation registry (lib/navigation.ts).
  const sections = visibleSections(user);
  const menuTabs = current ? sectionTabs(user, current) : [];

  return (
    <header className="topbar">
      <CommandPalette user={user} />
      <Link href="/" className="topbar__brand wordmark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
        <span className="wm-a">Snagged</span>
      </Link>

      {sections.length > 0 && (
        <nav className="topbar__nav">
          {sections.map((s) => {
            const cls = current === s.key ? "active" : "";
            // /research/* is the separate research app — full-nav anchor.
            return s.href.startsWith("/research") ? (
              <a key={s.key} href={s.href} className={cls}>{s.label}</a>
            ) : (
              <Link key={s.key} href={s.href} className={cls}>{s.label}</Link>
            );
          })}
        </nav>
      )}

      {/* Desktop: in-app back/refresh/share + bell + account avatar, grouped at the
          top-right (mirrors Research). Hidden on mobile (moves to the hamburger). */}
      <span className="topbar__account" style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <NavControls current={current} />
        {/* Universal — any logged-in user can log a feature request / tweak. */}
        <Link href="/feedback" title="Feedback & feature requests" aria-label="Feedback" style={{ fontSize: 18, lineHeight: 1, textDecoration: "none" }}>💡</Link>
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
              const isIndex = t.href === "/admin" || t.href === "/reports" || t.href === "/research";
              const active = isIndex ? pathname === t.href : Boolean(pathname && pathname.startsWith(t.href));
              const cls = active ? "active" : "";
              // /research/* is the separate research app — full-nav anchor.
              return t.href.startsWith("/research") ? (
                <a key={t.href} href={t.href} className={cls} onClick={() => setOpen(false)}>{t.label}</a>
              ) : (
                <Link key={t.href} href={t.href} className={cls} onClick={() => setOpen(false)}>{t.label}</Link>
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

// Back / refresh / share, mirroring the Research module's header. Rendered on the
// Admin + Reports surfaces (the hub landing doesn't need them). Share copies the
// current page URL — uses the native share sheet on mobile, falls back to the
// clipboard (with a brief "copied" confirmation), then to a prompt.
function NavControls({ current }: { current?: SectionKey }) {
  const [copied, setCopied] = useState(false);
  const pathname = usePathname();
  const isSection = current === "admin" || current === "reports" || current === "deals" || current === "snap" || current === "email";
  // Standalone pages that aren't in a section but still want the standard back/refresh/share.
  const isStandalone = (pathname || "").startsWith("/feedback");
  if (!isSection && !isStandalone) return null;
  const btn: React.CSSProperties = {
    width: 34, height: 34, borderRadius: "50%", border: "none", background: "transparent",
    color: "var(--navy, #254254)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const onShare = async () => {
    const url = window.location.href;
    // Only use the native share SHEET on an actual touch/mobile device. On desktop it just
    // copies the URL (the OS share sheet there is clunky and not what people expect).
    const isMobile = typeof navigator !== "undefined" &&
      (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
        (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches));
    if (isMobile && typeof navigator !== "undefined" && navigator.share) {
      try { await navigator.share({ title: document.title || "Snagged", url }); return; }
      catch (e) { if ((e as Error)?.name === "AbortError") return; /* dismissed — done */ }
    }
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
    try {
      if (!navigator.clipboard?.writeText) throw new Error("no clipboard");
      await navigator.clipboard.writeText(url);
      flash();
    } catch {
      try { window.prompt("Copy this link to share:", url); }
      catch { flash(); }
    }
  };
  return (
    <span className="topbar__pwa-nav" style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      <button type="button" aria-label="Back" title="Back" onClick={() => window.history.back()} style={btn}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <button type="button" aria-label="Refresh" title="Refresh" onClick={() => window.location.reload()} style={btn}>
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M23 4v6h-6" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
      </button>
      <button type="button" aria-label="Share" title={copied ? "Link copied!" : "Share"} onClick={onShare} style={btn}>
        {copied ? (
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="var(--teal-deep, #1f7a5a)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5" /></svg>
        ) : (
          <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.59 13.51l6.83 3.98" /><path d="M15.41 6.51l-6.82 3.98" /></svg>
        )}
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
