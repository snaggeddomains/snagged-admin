import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { visibleSections, sectionTabs } from "@/lib/navigation";
import TopBar from "./top-bar";

export const dynamic = "force-dynamic";

// /research/* is the separate research app (served via rewrite) — use a full-nav
// anchor to avoid a client-side RSC fetch that would 404. Everything else is a
// same-app <Link>.
function TaskLink({ href, label }: { href: string; label: string }) {
  return href.startsWith("/research") ? <a href={href}>{label}</a> : <Link href={href}>{label}</Link>;
}

// The umbrella landing hub. Every card + tile is derived from the navigation
// registry (lib/navigation.ts) — add a section or a tab there, not here.
export default async function Hub() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const sections = visibleSections(user);

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
        {sections.map((s) => (
          <section key={s.key} className="card hub-card">
            <h2><TaskLink href={s.href} label={s.label} /></h2>
            <p className="muted" style={{ marginTop: 0, fontSize: 14 }}>
              {s.blurb}
            </p>
            <ul className="hub-tasks">
              {sectionTabs(user, s.key).map((t) => (
                <li key={t.href}>
                  <TaskLink href={t.href} label={t.label} />
                </li>
              ))}
            </ul>
          </section>
        ))}

        {sections.length === 0 && (
          <p className="muted">
            You don&apos;t have access to any modules yet. Ask an administrator to grant
            permissions.
          </p>
        )}
      </div>
    </main>
  );
}
