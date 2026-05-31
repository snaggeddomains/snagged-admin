import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// The umbrella landing hub. After login, users land here and see the modules
// they have access to. New modules are added by appending to the lists below.
export default async function Hub() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const researchTasks = [
    { key: "research.domain_owner", label: "Domain Owner", href: "/research" },
    { key: "research.trademark", label: "Trademark", href: "/research/trademark" },
    { key: "research.appraisal", label: "Appraisal", href: "/research/appraisal" },
    { key: "research.naming", label: "Naming Exercise", href: "/research/naming" },
  ].filter((t) => userCan(user, t.key as Parameters<typeof userCan>[1]));

  const canResearch = researchTasks.length > 0;
  const canAdmin = userCan(user, "admin");

  return (
    <main style={{ maxWidth: 760, margin: "0 auto" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 28,
        }}
      >
        <div className="wordmark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="brand-mark" src="/brand/logomark-round.svg" alt="" />
          <span className="wm-a">Snagged</span>
        </div>
        <span style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span className="muted" style={{ fontSize: 14 }}>{user.email}</span>
          <a href="/api/logout" style={{ color: "var(--teal-deep)", fontWeight: 700, fontSize: 14 }}>
            Log out
          </a>
        </span>
      </header>

      <h1 style={{ fontSize: "1.4rem", marginBottom: 18 }}>Your workspaces</h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 18,
        }}
      >
        {canResearch && (
          <section className="card">
            <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
              <Link href="/research">Research</Link>
            </h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Domain ownership, trademark, appraisal &amp; naming research.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              {researchTasks.map((t) => (
                <li key={t.key}>
                  <Link href={t.href}>{t.label}</Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canAdmin && (
          <section className="card">
            <h2 style={{ marginTop: 0, fontSize: "1.15rem" }}>
              <Link href="/admin">Admin</Link>
            </h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Marketplace pipeline dashboard — sources, schedule, configuration &amp; users.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li><Link href="/admin">Sources</Link></li>
              <li><Link href="/admin/schedule">Schedule</Link></li>
              <li><Link href="/admin/users">Users</Link></li>
            </ul>
          </section>
        )}

        {!canResearch && !canAdmin && (
          <p className="muted">
            You don&apos;t have access to any modules yet. Ask an administrator to grant
            permissions.
          </p>
        )}
      </div>
    </main>
  );
}
