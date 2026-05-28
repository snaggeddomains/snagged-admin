import { loadFullRegistry, type Source } from "../../lib/sources";
import { editFile, workflowPathFor, runWorkflowPage } from "../../lib/github-links";

export const revalidate = 60;

interface ParsedCron {
  raw: string;
  minute: string;
  hour: string;
  human: string;
  /** First firing hour as a number (for sorting); null if not parseable. */
  hourSortKey: number | null;
}

/** Light cron parser sufficient for the patterns this pipeline uses:
 *   "M H * * *"           — once a day at H:M UTC
 *   "M H,H2,... * * *"    — multiple times a day
 *   "*\/N HA-HB * * *"    — every N minutes between hours HA and HB
 *   "M H * * 1-5"         — weekdays only
 */
function parseCron(raw: string | undefined): ParsedCron | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5) return { raw, minute: "?", hour: "?", human: raw, hourSortKey: null };
  const [m, h, _dom, _mon, _dow] = parts;

  let human: string;
  let hourSortKey: number | null = null;

  if (/^\*\/\d+$/.test(m) && /^\d+-\d+$/.test(h)) {
    const stepMatch = m.match(/^\*\/(\d+)$/);
    const rangeMatch = h.match(/^(\d+)-(\d+)$/);
    const step = stepMatch ? stepMatch[1] : "?";
    const hStart = rangeMatch ? Number(rangeMatch[1]) : null;
    const hEnd = rangeMatch ? rangeMatch[2] : "?";
    human = `every ${step} min, ${hStart ?? "?"}:00–${hEnd}:59 UTC`;
    hourSortKey = hStart;
  } else if (h.includes(",")) {
    const hours = h.split(",").map((x) => x.trim());
    const minN = m === "0" ? "00" : m.padStart(2, "0");
    human = hours.map((hh) => `${hh.padStart(2, "0")}:${minN} UTC`).join(", ");
    const firstHour = Number(hours[0]);
    hourSortKey = Number.isFinite(firstHour) ? firstHour : null;
  } else if (/^\d+$/.test(m) && /^\d+$/.test(h)) {
    const minN = m.padStart(2, "0");
    const hN = h.padStart(2, "0");
    human = `${hN}:${minN} UTC`;
    hourSortKey = Number(h);
  } else {
    human = raw;
  }

  return { raw, minute: m, hour: h, human, hourSortKey };
}

/** Approximate ET label for a UTC hour. Assumes EDT (UTC-4) most of the year;
 *  this is a hint, not exact for the DST transition windows. */
function approxEtLabel(utcHour: number, minute: string): string {
  const minN = /^\d+$/.test(minute) ? minute.padStart(2, "0") : minute;
  const edt = (utcHour - 4 + 24) % 24;
  const est = (utcHour - 5 + 24) % 24;
  return `~${edt.toString().padStart(2, "0")}:${minN} ET (EDT) · ${est
    .toString()
    .padStart(2, "0")}:${minN} EST`;
}

function ScheduleRow({ s }: { s: Source }) {
  const cron = parseCron(s.schedule_utc);
  if (!cron) return null;
  const et =
    cron.hourSortKey != null ? approxEtLabel(cron.hourSortKey, cron.minute) : "—";
  return (
    <tr style={{ borderTop: "1px solid #f3f4f6" }}>
      <td
        style={{
          padding: "10px 0",
          color: "#6b7280",
          fontFamily: "ui-monospace, Menlo, monospace",
          width: 110,
          whiteSpace: "nowrap",
        }}
      >
        {cron.raw}
      </td>
      <td style={{ padding: "10px 0", width: 220 }}>{cron.human}</td>
      <td style={{ padding: "10px 0", color: "#6b7280", fontSize: 12 }}>{et}</td>
      <td
        style={{
          padding: "10px 0",
          fontFamily: "ui-monospace, Menlo, monospace",
        }}
      >
        {s.source_id}
      </td>
      <td style={{ padding: "10px 0", color: "#6b7280" }}>{s.kind}</td>
      <td style={{ padding: "10px 0", textAlign: "right", whiteSpace: "nowrap" }}>
        <a
          href={runWorkflowPage(s.source_id)}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            fontSize: 12,
            color: "#3b82f6",
            textDecoration: "none",
            marginRight: 12,
          }}
        >
          run now →
        </a>
        <a
          href={editFile(workflowPathFor(s.source_id))}
          target="_blank"
          rel="noopener noreferrer"
          style={{ fontSize: 12, color: "#3b82f6", textDecoration: "none" }}
        >
          edit schedule →
        </a>
      </td>
    </tr>
  );
}

export default async function SchedulePage() {
  const hasToken = !!process.env.GITHUB_TOKEN;
  if (!hasToken) {
    return (
      <div
        style={{
          background: "#fef3c7",
          border: "1px solid #f59e0b",
          padding: 16,
          borderRadius: 6,
          fontSize: 14,
        }}
      >
        <strong>GITHUB_TOKEN not set.</strong> Configure to load registry.
      </div>
    );
  }

  const reg = await loadFullRegistry();

  // Only show sources with a parsable schedule
  const scheduled = reg.sources
    .filter((s) => s.enabled !== false && s.schedule_utc)
    .map((s) => ({ source: s, cron: parseCron(s.schedule_utc) }))
    .filter((x): x is { source: Source; cron: ParsedCron } => x.cron !== null);

  // Sort by first firing hour
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
      <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0, marginBottom: 24 }}>
        Schedules live in <code>.github/workflows/source-&lt;id&gt;.yml</code>.
        Cron expressions are UTC (GitHub Actions does not support local TZs);
        ET equivalents are approximate and drift one hour at DST boundaries.
      </p>

      <section style={{ marginBottom: 36 }}>
        <h2 style={{ fontSize: 18, marginBottom: 12, fontWeight: 600 }}>
          Daily timeline
          <span style={{ color: "#9ca3af", fontWeight: 400 }}>
            {" "}
            · {scheduled.length} scheduled
          </span>
        </h2>
        {scheduled.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 13 }}>
            No scheduled sources yet — workflows are manual-trigger only until
            the cron is enabled in their YAML.
          </p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
                <th style={{ padding: "8px 0" }}>cron</th>
                <th style={{ padding: "8px 0" }}>when (UTC)</th>
                <th style={{ padding: "8px 0" }}>ET (approx)</th>
                <th style={{ padding: "8px 0" }}>source_id</th>
                <th style={{ padding: "8px 0" }}>kind</th>
                <th style={{ padding: "8px 0", textAlign: "right" }}></th>
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
        <section style={{ marginBottom: 36 }}>
          <h2 style={{ fontSize: 18, marginBottom: 12, fontWeight: 600 }}>
            Unscheduled (manual trigger only)
            <span style={{ color: "#9ca3af", fontWeight: 400 }}>
              {" "}
              · {unscheduled.length}
            </span>
          </h2>
          <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0, marginBottom: 12 }}>
            These sources don't have a schedule defined in{" "}
            <code>sources.yaml</code> — typically orchestrator-fed (auction
            sources run inside <code>auctions_publish</code>) or sources that
            haven't been wired yet.
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#6b7280", fontSize: 12 }}>
                <th style={{ padding: "8px 0" }}>source_id</th>
                <th style={{ padding: "8px 0" }}>product</th>
                <th style={{ padding: "8px 0" }}>kind</th>
              </tr>
            </thead>
            <tbody>
              {unscheduled.map((s) => (
                <tr key={s.source_id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td
                    style={{
                      padding: "8px 0",
                      fontFamily: "ui-monospace, Menlo, monospace",
                    }}
                  >
                    {s.source_id}
                  </td>
                  <td style={{ padding: "8px 0", color: "#6b7280" }}>
                    {s.product}
                  </td>
                  <td style={{ padding: "8px 0", color: "#6b7280" }}>{s.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <footer
        style={{
          marginTop: 48,
          paddingTop: 16,
          borderTop: "1px solid #e5e7eb",
          fontSize: 12,
          color: "#9ca3af",
        }}
      >
        Sources of truth: each workflow's cron block ·{" "}
        <a
          href={editFile("sources.yaml")}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#3b82f6", textDecoration: "none" }}
        >
          edit sources.yaml →
        </a>
      </footer>
    </>
  );
}
