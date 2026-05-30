import { loadFullRegistry, type Source } from "../../lib/sources";
import { editFile, workflowPathFor, runWorkflowPage } from "../../lib/github-links";
import { parseCron, etTimeLabel, type ParsedCron } from "../../lib/cron";
import KindPill from "../kind-pill";

export const revalidate = 60;

type Bucketed = {
  scheduled: { source: Source; cron: ParsedCron }[];
  orchestrated: { source: Source; parent: Source; parentCron: ParsedCron }[];
  manual: Source[];
};

function bucketSources(sources: Source[]): Bucketed {
  // First pass: map every orchestrated child → parent (for inherited schedule)
  const orchestratorByChild = new Map<string, Source>();
  for (const parent of sources) {
    if (parent.orchestrates?.length) {
      for (const childId of parent.orchestrates) {
        orchestratorByChild.set(childId, parent);
      }
    }
  }

  const scheduled: Bucketed["scheduled"] = [];
  const orchestrated: Bucketed["orchestrated"] = [];
  const manual: Source[] = [];

  for (const s of sources) {
    if (s.enabled === false) continue;
    const ownCron = parseCron(s.schedule_utc);
    if (ownCron) {
      scheduled.push({ source: s, cron: ownCron });
      continue;
    }
    const parent = orchestratorByChild.get(s.source_id);
    const parentCron = parent && parseCron(parent.schedule_utc);
    if (parent && parentCron) {
      orchestrated.push({ source: s, parent, parentCron });
      continue;
    }
    manual.push(s);
  }

  const sortByCron = <T extends { cron: ParsedCron } | { parentCron: ParsedCron }>(
    a: T, b: T,
  ) => {
    const ac = "cron" in a ? a.cron : a.parentCron;
    const bc = "cron" in b ? b.cron : b.parentCron;
    const ha = ac.hourSortKey ?? 99;
    const hb = bc.hourSortKey ?? 99;
    if (ha !== hb) return ha - hb;
    const ma = Number(ac.minute);
    const mb = Number(bc.minute);
    return (Number.isFinite(ma) ? ma : 99) - (Number.isFinite(mb) ? mb : 99);
  };
  scheduled.sort(sortByCron);
  orchestrated.sort(sortByCron);

  return { scheduled, orchestrated, manual };
}

function ActionLinks({ s }: { s: Source }) {
  return (
    <>
      <a
        href={runWorkflowPage(s.source_id)}
        target="_blank"
        rel="noopener noreferrer"
        className="link-out"
      >
        run now →
      </a>
      <a
        href={editFile(workflowPathFor(s.source_id))}
        target="_blank"
        rel="noopener noreferrer"
        className="link-out"
      >
        edit →
      </a>
    </>
  );
}

const COLGROUP = (
  <colgroup>
    <col style={{ width: 230 }} />
    <col style={{ width: "30%" }} />
    <col style={{ width: 130 }} />
    <col />
  </colgroup>
);

const TABLE_STYLE = { tableLayout: "fixed" as const, width: "100%" };

export default async function SchedulePage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  if (!hasToken) {
    return (
      <div className="warn-callout">
        <strong>GITHUB_TOKEN not set.</strong> Configure to load registry.
      </div>
    );
  }

  const reg = await loadFullRegistry();
  const { scheduled, orchestrated, manual } = bucketSources(reg.sources);

  return (
    <>
      <p style={{ color: "var(--navy-3)", fontSize: 14, marginTop: 0, marginBottom: 24 }}>
        Times shown in Eastern Time (auto-adjusted for EDT/EST). Schedules
        live in <code>.github/workflows/source-&lt;id&gt;.yml</code> — cron
        expressions there are UTC.
      </p>

      <section>
        <h2>
          Daily timeline
          <span className="count">· {scheduled.length} directly scheduled</span>
        </h2>
        {scheduled.length === 0 ? (
          <p className="section-blurb">No directly-scheduled sources yet.</p>
        ) : (
          <table className="dash" style={TABLE_STYLE}>
            {COLGROUP}
            <thead>
              <tr>
                <th>time (ET)</th>
                <th>source_id</th>
                <th>kind</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map(({ source, cron }) => (
                <tr key={source.source_id}>
                  <td style={{ fontWeight: 600 }}>{etTimeLabel(cron)}</td>
                  <td className="mono">{source.source_id}</td>
                  <td><KindPill kind={source.kind} /></td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <ActionLinks s={source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {orchestrated.length > 0 && (
        <section>
          <h2>
            Orchestrated
            <span className="count">
              · {orchestrated.length} inherit a parent's schedule
            </span>
          </h2>
          <p className="section-blurb">
            These sources don't have their own cron — they run inside an
            orchestrator workflow (almost always <code>auctions_publish</code>
            ) that pulls them in sequence. "Run now" triggers the source
            directly via its own workflow_dispatch for ad-hoc testing.
          </p>
          <table className="dash" style={TABLE_STYLE}>
            {COLGROUP}
            <thead>
              <tr>
                <th>time (ET)</th>
                <th>source_id</th>
                <th>kind</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {orchestrated.map(({ source, parent, parentCron }) => (
                <tr key={source.source_id}>
                  <td>
                    <span style={{ fontWeight: 600 }}>
                      {etTimeLabel(parentCron)}
                    </span>
                    <div style={{ fontSize: 11, color: "var(--navy-3)", marginTop: 2 }}>
                      via {parent.source_id}
                    </div>
                  </td>
                  <td className="mono">{source.source_id}</td>
                  <td><KindPill kind={source.kind} /></td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <ActionLinks s={source} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {manual.length > 0 && (
        <section>
          <h2>
            Manual trigger only
            <span className="count">· {manual.length}</span>
          </h2>
          <p className="section-blurb">
            No schedule defined and no parent orchestrator — fired only
            through the GitHub Actions "Run workflow" button.
          </p>
          <table className="dash" style={TABLE_STYLE}>
            {COLGROUP}
            <thead>
              <tr>
                <th>time (ET)</th>
                <th>source_id</th>
                <th>kind</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {manual.map((s) => (
                <tr key={s.source_id}>
                  <td className="muted">—</td>
                  <td className="mono">{s.source_id}</td>
                  <td><KindPill kind={s.kind} /></td>
                  <td className="right" style={{ whiteSpace: "nowrap" }}>
                    <ActionLinks s={s} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer className="page-footer">
        Sources of truth: each workflow's cron block ·{" "}
        <a href={editFile("sources.yaml")} target="_blank" rel="noopener noreferrer">
          edit sources.yaml →
        </a>
      </footer>
    </>
  );
}
