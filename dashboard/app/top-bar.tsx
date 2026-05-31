import Link from "next/link";
import { userCan, MODULES, type AppUser } from "@/lib/permissions";

// The global chrome shared across every umbrella surface (hub, admin) and
// mirrored by research. Logo -> hub, permission-aware module switcher, account.
// Module links only render for modules the user can access, so a Research-only
// user sees no Admin link at all.
export default function TopBar({
  user,
  current,
}: {
  user: AppUser;
  current?: "research" | "admin";
}) {
  const canResearch = MODULES.some((m) => m.startsWith("research.") && userCan(user, m));
  const canAdmin = userCan(user, "admin");

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

      <span className="topbar__account">
        <span className="muted">{user.email}</span>
        <a href="/api/logout">Log out</a>
      </span>
    </header>
  );
}
