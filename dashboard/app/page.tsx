import {
  loadAllSourcesWithStatus,
  loadReferences,
  type Reference,
  type SourceWithStatus,
} from "../lib/sources";
import {
  editFile,
  viewFile,
  sourceModulePathFor,
  runWorkflowPage,
} from "../lib/github-links";
import { parseCron, etTimeLabel } from "../lib/cron";
import KindPill from "./kind-pill";

export const revalidate = 60;

const PRODUCT_LABEL: Record<string, string> = {
  snap: "SNAP",
  auctions: "Auctions",
  aux: "Aux feeds",
};

type StatusKey = "ok" | "stale" | "failed" | "never_run" | "todo" | "disabled";

function statusInfo(s: SourceWithStatus): { key: StatusKey; label: string } {
  if (s.enabled === false) return { key: "disabled", label: "disabled" };
  if (!s.wired) return { key: "todo", label: "TODO — not wired" };
  if (!s.runStatus) return { key: "never_run", label: "wired · never run" };
  if (s.runStatus.status === "failed") return { key: "failed", label: "failed" };
  if (s.runStatus.status === "ok") {
    const ageHours =
      (Date.now() - new Date(s.runStatus.generated_at).getTime()) / 1000 / 3600;
    if (ageHours < 26) return { key: "ok", label: "ok" };
    return { key: "stale", label: `stale (${Math.round(ageHours)}h)` };
  }
  return { key: "never_run", label: s.runStatus.status };
}

function relativeTime(iso: string): string {
  const ageSec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86400)}d ago`;
}

function LinkOut({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link-out">
      {label} →
    </a>
  );
}

function scheduleCell(
  s: SourceWithStatus,
  orchestratorById: Map<string, SourceWithStatus>,
): React.ReactNode {
  const own = parseCron(s.schedule_utc);
  if (own) return etTimeLabel(own);
  const parent = orchestratorById.get(s.source_id);
  const parentCron = parent && parseCron(parent.schedule_utc);
  if (parent && parentCron) {
    return (
      <span title={`Triggered by ${parent.source_id}`}>
        {etTimeLabel(parentCron)}
        <span style={{ color: "var(--navy-3)", marginLeft: 6, fontSize: 12 }}>
          via {parent.source_id}
        </span>
      </span>
    );
  }
  return "—";
}

function SourceRow({
  s,
  orchestratorById,
}: {
  s: SourceWithStatus;
  orchestratorById: Map<string, SourceWithStatus>;
}) {
  const info = statusInfo(s);
  const dim = info.key === "todo" || info.key === "disabled";
  const showReason = (info.key === "todo" || info.key === "disabled") && s.reason;
  return (
    <tr className={dim ? "dim" : undefined}>
      <td>
        <span title={info.label} className={`dot dot--${info.key}`} />
      </td>
      <td className="mono">
        {s.source_id}
        {info.key === "todo" && <span className="todo-badge">todo</span>}
        {showReason && (
          <div
            style={{
              fontFamily: "var(--font-body, system-ui)",
              fontSize: 11,
              color: "var(--navy-3)",
              marginTop: 4,
              maxWidth: 360,
              whiteSpace: "normal",
              lineHeight: 1.35,
            }}
          >
            {s.reason}
          </div>
        )}
      </td>
      <td><KindPill kind={s.kind} /></td>
      <td className="muted">{scheduleCell(s, orchestratorById)}</td>
      <td className="muted">
        {s.runStatus ? relativeTime(s.runStatus.generated_at) : "—"}
      </td>
      <td className="num">{s.runStatus?.new_count ?? "—"}</td>
      <td className="right" style={{ whiteSpace: "nowrap" }}>
        {s.wired && <LinkOut href={runWorkflowPage(s.source_id)} label="run" />}
        {s.wired && (
          <LinkOut href={viewFile(sourceModulePathFor(s.source_id))} label="code" />
        )}
        {!s.wired && <LinkOut href={editFile("sources.yaml")} label="edit registry" />}
      </td>
    </tr>
  );
}

function SourceTable({
  items,
  orchestratorById,
}: {
  items: SourceWithStatus[];
  orchestratorById: Map<string, SourceWithStatus>;
}) {
  return (
    <table className="dash" style={{ tableLayout: "fixed", width: "100%" }}>
      <colgroup>
        <col style={{ width: 30 }} />
        <col style={{ width: "22%" }} />
        <col style={{ width: 130 }} />
        <col style={{ width: "26%" }} />
        <col style={{ width: 100 }} />
        <col style={{ width: 110 }} />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th></th>
          <th>source_id</th>
          <th>kind</th>
          <th>schedule (ET)</th>
          <th>last run</th>
          <th className="right">new&nbsp;today</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => (
          <SourceRow key={s.source_id} s={s} orchestratorById={orchestratorById} />
        ))}
      </tbody>
    </table>
  );
}

function ReferencesSection({ refs }: { refs: Reference[] }) {
  if (!refs.length) return null;
  return (
    <section>
      <h2>
        References<span className="count">· {refs.length}</span>
      </h2>
      <p className="section-blurb">
        Read-only data stores queried ad-hoc during naming workflows. Not on a
        schedule.
      </p>
      <table className="dash">
        <thead>
          <tr>
            <th>ref_id</th>
            <th>kind</th>
            <th>table / endpoint</th>
            <th>cadence</th>
          </tr>
        </thead>
        <tbody>
          {refs.map((r) => (
            <tr key={r.ref_id}>
              <td className="mono">{r.ref_id}</td>
              <td><KindPill kind={r.kind} /></td>
              <td className="muted mono">{r.table ?? "—"}</td>
              <td className="muted">{r.cadence ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default async function SourcesPage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  const [sources, refs] = hasToken
    ? await Promise.all([loadAllSourcesWithStatus(), loadReferences()])
    : [[] as SourceWithStatus[], [] as Reference[]];

  const byProduct: Record<string, SourceWithStatus[]> = {};
  for (const s of sources) {
    (byProduct[s.product] ||= []).push(s);
  }

  // Map every orchestrated child source -> its orchestrator entry so the
  // schedule column can inherit the orchestrator's cron.
  const orchestratorById = new Map<string, SourceWithStatus>();
  for (const parent of sources) {
    if (parent.orchestrates?.length) {
      for (const childId of parent.orchestrates) {
        orchestratorById.set(childId, parent);
      }
    }
  }

  const ORDER: Record<StatusKey, number> = {
    ok: 0, stale: 1, failed: 2, never_run: 3, disabled: 4, todo: 5,
  };
  for (const p of Object.keys(byProduct)) {
    byProduct[p].sort((a, b) => ORDER[statusInfo(a).key] - ORDER[statusInfo(b).key]);
  }

  const counts: Record<StatusKey, number> = {
    ok: 0, stale: 0, failed: 0, never_run: 0, todo: 0, disabled: 0,
  };
  for (const s of sources) counts[statusInfo(s).key]++;
  const total = sources.length;
  const wiredCount = sources.filter((s) => s.wired && s.enabled !== false).length;

  return (
    <>
      {!hasToken && (
        <div className="warn-callout">
          <strong>GITHUB_TOKEN not set.</strong> Set GITHUB_TOKEN as an env var
          (fine-grained PAT with Contents: Read on this repo) to see live data.
        </div>
      )}

      {hasToken && (
        <div className="counter-strip">
          <span>
            <strong>{wiredCount} / {total}</strong> wired
          </span>
          <span><span className="dot dot--ok" /> <strong>{counts.ok}</strong> ok</span>
          <span><span className="dot dot--stale" /> <strong>{counts.stale}</strong> stale</span>
          <span><span className="dot dot--failed" /> <strong>{counts.failed}</strong> failed</span>
          <span><span className="dot dot--never" /> <strong>{counts.never_run}</strong> never run</span>
          <span><span className="dot dot--todo" /> <strong>{counts.todo}</strong> todo</span>
          <span><span className="dot dot--disabled" /> <strong>{counts.disabled}</strong> disabled</span>
        </div>
      )}

      {(["snap", "auctions", "aux"] as const).map((product) => {
        const items = byProduct[product] ?? [];
        if (!items.length) return null;
        const wired = items.filter((s) => s.wired && s.enabled !== false).length;
        return (
          <section key={product}>
            <h2>
              {PRODUCT_LABEL[product]}
              <span className="count">· {wired}/{items.length} wired</span>
            </h2>
            <SourceTable items={items} orchestratorById={orchestratorById} />
          </section>
        );
      })}

      <ReferencesSection refs={refs} />

      <footer className="page-footer">
        Page revalidates every 60 seconds ·{" "}
        <a href={editFile("sources.yaml")} target="_blank" rel="noopener noreferrer">
          Edit sources.yaml on GitHub →
        </a>
      </footer>
    </>
  );
}
