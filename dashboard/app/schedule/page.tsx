import { loadFullRegistry, type Source } from "../../lib/sources";
import { editFile, workflowPathFor, runWorkflowPage } from "../../lib/github-links";

export const revalidate = 60;

interface ParsedCron {
  raw: string;
  minute: string;
  hour: string;
  human: string;
  hourSortKey: number | null;
}

function parseCron(raw: string | undefined): ParsedCron | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5)
    return { raw, minute: "?", hour: "?", human: raw, hourSortKey: null };
  const [m, h] = parts;

  let human: string;
  let hourSortKey: number | null = null;

  if (/^\*\/\d+$/.test(m) && /^\d+-\d+$/.test(h)) {
    const step = m.match(/^\*\/(\d+)$/)?.[1] ?? "?";
    const range = h.match(/^(\d+)-(\d+)$/);
    const hStart = range ? Number(range[1]) : null;
    const hEnd = range ? range[2] : "?";
    human = `every ${step} min, ${hStart ?? "?"}:00–${hEnd}:59 UTC`;
    hourSortKey = hStart;
  } else if (h.includes(",")) {
    const hours = h.split(",").map((x) => x.trim());
    const minN = m === "0" ? "00" : m.padStart(2, "0");
    human = hours.map((hh) => `${hh.padStart(2, "0")}:${minN} UTC`).join(", ");
    const firstHour = Number(hours[0]);
    hourSortKey = Number.isFinite(firstHour) ? firstHour : null;
  } else if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    human = `${h.padStart(2, "0")}:${m.padStart(2, "0")} UTC`;
    hourSortKey = Number(h);
  } else {
    human = raw;
  }

  return { raw, minute: m, hour: h, human, hourSortKey };
}

/** Format a UTC time as Eastern Time, picking EDT or EST automatically
 *  based on whether NY is currently observing DST at render time. */
function etTimeLabel(cron: ParsedCron): string {
  // For multi-fire crons we still render only the first occurrence's time
  // here — the human-readable cron expression below shows the full set.
  const utcHour = cron.hourSortKey;
  if (utcHour == null) return cron.human;
  const minN = /^\d+$/.test(cron.minute) ? Number(cron.minute) : 0;
  const today = new Date();
  const utcDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), utcHour, minN, 0),
  );
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(utcDate);
}

function ScheduleRow({ s }: { s: Source }) {
  const cron = parseCron(s.schedule_utc);
  if (!cron) return null;
  const et = etTimeLabel(cron);
  return (
    <tr>
      <td style={{ width: 140, whiteSpace: "nowrap", fontWeight: 600 }}>{et}</td>
      <td className="mono">{s.source_id}</td>
      <td className="muted">{s.kind}</td>
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
                  <td className="muted">{s.kind}</td>
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
