import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { userCan } from "@/lib/permissions";
import TopBar from "./top-bar";

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
    { key: "research.dbscreen", label: "Domain DB Screen", href: "/research/dbscreen" },
    { key: "research.dbsearch", label: "Domain Name Search", href: "/research/dbsearch" },
    { key: "research.nameserver", label: "Nameserver Search", href: "/research/nameserver" },
  ].filter((t) => userCan(user, t.key as Parameters<typeof userCan>[1]));

  const canResearch = researchTasks.length > 0;
  const canAdmin = userCan(user, "admin");

  return (
    <main>
      <TopBar user={user} />

      <div className="hub-hero">
        <div>
          <h1>Your workspaces</h1>
          <p className="muted" style={{ margin: 0 }}>
            Jump into a tool or manage the pipeline.
          </p>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mascot-hero.png" alt="" />
      </div>

      <div className="hub-grid">
        {canResearch && (
          <section className="card hub-card">
            <h2><Link href="/research">Research</Link></h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Domain ownership, trademark, appraisal &amp; naming research.
            </p>
            <ul className="hub-tasks">
              {researchTasks.map((t) => (
                <li key={t.key}>
                  <Link href={t.href}>{t.label}</Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canAdmin && (
          <section className="card hub-card">
            <h2><Link href="/admin">Admin</Link></h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              Marketplace pipeline dashboard — sources, schedule, configuration &amp; users.
            </p>
            <ul className="hub-tasks">
              <li><Link href="/admin">Sources</Link></li>
              <li><Link href="/admin/config">Configuration</Link></li>
              <li><Link href="/admin/schedule">Schedule</Link></li>
              <li><Link href="/admin/users">Users</Link></li>
              <li><Link href="/admin/imports">Imports</Link></li>
              <li><a href="/research/admin">Lessons</a></li>
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
