import { loadFullRegistry, type Source } from "../../lib/sources";
import { editFile, workflowPathFor, runWorkflowPage } from "../../lib/github-links";
import { parseCron, etTimeLabel, type ParsedCron } from "../../lib/cron";
import KindPill from "../kind-pill";

export const revalidate = 60;

function ScheduleRow({ s }: { s: Source }) {
  const cron = parseCron(s.schedule_utc);
  if (!cron) return null;
  const et = etTimeLabel(cron);
  return (
    <tr>
      <td style={{ width: 140, whiteSpace: "nowrap", fontWeight: 600 }}>{et}</td>
      <td className="mono">{s.source_id}</td>
      <td><KindPill kind={s.kind} /></td>
      <td className="right" style={{ whiteSpace: "nowrap" }}>
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
      </td>
    </tr>
  );
}

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

  const scheduled = reg.sources
    .filter((s) => s.enabled !== false && s.schedule_utc)
    .map((s) => ({ source: s, cron: parseCron(s.schedule_utc) }))
    .filter((x): x is { source: Source; cron: ParsedCron } => x.cron !== null);

  scheduled.sort((a, b) => {
    const ha = a.cron.hourSortKey ?? 99;
    const hb = b.cron.hourSortKey ?? 99;
    if (ha !== hb) return ha - hb;
    const ma = Number(a.cron.minute);
    const mb = Number(b.cron.minute);
    return (Number.isFinite(ma) ? ma : 99) - (Number.isFinite(mb) ? mb : 99);
  });

  const unscheduled = reg.sources.filter(
    (s) => s.enabled !== false && !s.schedule_utc,
  );

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
          <span className="count">· {scheduled.length} scheduled</span>
        </h2>
        {scheduled.length === 0 ? (
          <p className="section-blurb">
            No scheduled sources yet — workflows are manual-trigger only until
            the cron is enabled in their YAML.
          </p>
        ) : (
          <table className="dash">
            <thead>
              <tr>
                <th>time (ET)</th>
                <th>source_id</th>
                <th>kind</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {scheduled.map(({ source }) => (
                <ScheduleRow key={source.source_id} s={source} />
              ))}
            </tbody>
          </table>
        )}
      </section>

      {unscheduled.length > 0 && (
        <section>
          <h2>
            Unscheduled (manual trigger only)
            <span className="count">· {unscheduled.length}</span>
          </h2>
          <p className="section-blurb">
            These sources don't have a schedule defined in <code>sources.yaml</code> —
            typically orchestrator-fed (auction sources run inside{" "}
            <code>auctions_publish</code>) or sources that haven't been wired yet.
          </p>
          <table className="dash">
            <thead>
              <tr>
                <th>source_id</th>
                <th>product</th>
                <th>kind</th>
              </tr>
            </thead>
            <tbody>
              {unscheduled.map((s) => (
                <tr key={s.source_id}>
                  <td className="mono">{s.source_id}</td>
                  <td className="muted">{s.product}</td>
                  <td><KindPill kind={s.kind} /></td>
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
