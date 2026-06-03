import {
  loadAllSourcesWithStatus,
  loadReferences,
  type Reference,
  type SourceWithStatus,
} from "@/lib/sources";
import {
  editFile,
  viewFile,
  sourceModulePathFor,
  runWorkflowPage,
} from "@/lib/github-links";
import { parseCron, etTimeLabel } from "@/lib/cron";
import KindPill from "@/app/kind-pill";
import SourceTable, { type RowVM } from "./source-row";

export const revalidate = 60;

const PRODUCT_LABEL: Record<string, string> = {
  snap: "SNAP",
  auctions: "Auctions",
  aux: "Aux feeds",
};

type StatusKey = "ok" | "stale" | "failed" | "never_run" | "todo" | "disabled";

const GRACE_HOURS = 3; // GitHub cron delay/jitter buffer

// Largest gap (hours) between consecutive firings within a day, from a cron
// HOUR field. "*"->hourly, "A-B"->overnight gap, "H" or "H,H2,.."->computed.
function maxGapFromHours(hourField: string): number {
  if (hourField === "*") return 1;
  const range = hourField.match(/^(\d+)-(\d+)$/);
  if (range) return Math.max(1, 24 - (Number(range[2]) - Number(range[1])));
  if (/^\d+(,\d+)*$/.test(hourField)) {
    const hrs = hourField.split(",").map(Number).sort((a, b) => a - b);
    if (hrs.length === 1) return 24;
    let max = 0;
    for (let i = 0; i < hrs.length; i++) {
      const next = i + 1 < hrs.length ? hrs[i + 1] : hrs[0] + 24;
      max = Math.max(max, next - hrs[i]);
    }
    return max;
  }
  return 24;
}

// Hours after which an "ok" source should be considered stale, derived from
// its schedule. Returns null when staleness shouldn't be assessed on age:
//   - no/un-parseable schedule ("manual") — nothing drives a cadence
//   - less-than-daily (restricted day-of-month/week/month) — the light cron
//     parser can't model the real interval, so don't false-flag (e.g. biweekly)
function staleThresholdHours(raw: string | undefined): number | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5) return null; // "manual" / non-cron
  const [, hour, dom, mon, dow] = parts;
  if (dom !== "*" || mon !== "*" || dow !== "*") return null; // < daily
  return maxGapFromHours(hour) + GRACE_HOURS;
}

function statusInfo(
  s: SourceWithStatus,
  orchestratorById: Map<string, SourceWithStatus>,
): { key: StatusKey; label: string } {
  if (s.enabled === false) return { key: "disabled", label: "disabled" };
  if (!s.wired) return { key: "todo", label: "TODO — not wired" };
  if (!s.runStatus) return { key: "never_run", label: "wired · never run" };
  if (s.runStatus.status === "failed") return { key: "failed", label: "failed" };
  if (s.runStatus.status === "ok") {
    // Effective schedule: the source's own cron, else its orchestrator's.
    const raw = s.schedule_utc || orchestratorById.get(s.source_id)?.schedule_utc;
    const threshold = staleThresholdHours(raw);
    if (threshold === null) return { key: "ok", label: "ok" }; // manual / infrequent
    const ageHours =
      (Date.now() - new Date(s.runStatus.generated_at).getTime()) / 1000 / 3600;
    if (ageHours < threshold) return { key: "ok", label: "ok" };
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

function scheduleParts(
  s: SourceWithStatus,
  orchestratorById: Map<string, SourceWithStatus>,
): { label: string; via?: string } {
  const own = parseCron(s.schedule_utc);
  if (own) return { label: etTimeLabel(own) };
  const parent = orchestratorById.get(s.source_id);
  const parentCron = parent && parseCron(parent.schedule_utc);
  if (parent && parentCron) return { label: etTimeLabel(parentCron), via: parent.source_id };
  return { label: "—" };
}

// Flatten a source + its computed status into the serializable shape the client
// row component renders (the row is a client component so the "new today" count
// can lazily expand to the actual names).
function toVM(
  s: SourceWithStatus,
  orchestratorById: Map<string, SourceWithStatus>,
): RowVM {
  const info = statusInfo(s, orchestratorById);
  const sched = scheduleParts(s, orchestratorById);
  return {
    sourceId: s.source_id,
    kind: s.kind,
    statusKey: info.key,
    statusLabel: info.label,
    dim: info.key === "todo" || info.key === "disabled",
    todo: info.key === "todo",
    scheduleLabel: sched.label,
    scheduleVia: sched.via,
    lastRun: s.runStatus ? relativeTime(s.runStatus.generated_at) : "—",
    newCount: s.runStatus?.new_count ?? null,
    wired: !!s.wired,
    runHref: runWorkflowPage(s.source_id),
    codeHref: viewFile(sourceModulePathFor(s.source_id)),
    editHref: editFile("sources.yaml"),
  };
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
      <div className="table-scroll">
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
      </div>
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

  // Order each product group by its effective schedule time (the source's own
  // cron, else its orchestrator's). Sorting by UTC time-of-day preserves the ET
  // order shown in the schedule column. Manual / unparseable schedules sort last,
  // then alphabetical as a stable tiebreaker.
  const schedKey = (s: SourceWithStatus) => {
    const cron = parseCron(s.schedule_utc)
      || parseCron(orchestratorById.get(s.source_id)?.schedule_utc);
    if (!cron || cron.hourSortKey == null) return Number.POSITIVE_INFINITY;
    const min = /^\d+$/.test(cron.minute) ? Number(cron.minute) : 0;
    return cron.hourSortKey * 60 + min;
  };
  for (const p of Object.keys(byProduct)) {
    byProduct[p].sort((a, b) => {
      const d = schedKey(a) - schedKey(b);
      if (d !== 0) return d;
      return a.source_id.localeCompare(b.source_id);
    });
  }

  const counts: Record<StatusKey, number> = {
    ok: 0, stale: 0, failed: 0, never_run: 0, todo: 0, disabled: 0,
  };
  for (const s of sources) counts[statusInfo(s, orchestratorById).key]++;
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
            <SourceTable rows={items.map((s) => toVM(s, orchestratorById))} />
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
