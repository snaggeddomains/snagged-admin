// Shared cron parsing + ET formatting for the dashboard.
// Cron expressions in sources.yaml are UTC; users want to see ET
// (EDT/EST is resolved automatically via Intl.DateTimeFormat).

export interface ParsedCron {
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
 */
export function parseCron(raw: string | undefined): ParsedCron | null {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 5) {
    return { raw, minute: "?", hour: "?", human: raw, hourSortKey: null };
  }
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

/** Format a parsed cron as an ET time string (e.g. "5:25 AM EDT").
 *  Uses Intl.DateTimeFormat in America/New_York so EDT/EST is automatic. */
export function etTimeLabel(cron: ParsedCron): string {
  const utcHour = cron.hourSortKey;
  if (utcHour == null) return cron.human;
  const minN = /^\d+$/.test(cron.minute) ? Number(cron.minute) : 0;
  const today = new Date();
  const utcDate = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), utcHour, minN, 0),
  );
  const single = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(utcDate);

  // If the cron fires at multiple hours (e.g., "0 10,17,23 * * *"), show
  // them all in ET, comma-separated, with one tz label at the end.
  if (cron.hour.includes(",")) {
    const hours = cron.hour.split(",").map((x) => x.trim());
    if (hours.length > 1) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      const tzMatch = single.match(/\s([A-Z]{2,4})$/);
      const tz = tzMatch ? tzMatch[1] : "";
      const parts = hours.map((hh) => {
        const hN = Number(hh);
        if (!Number.isFinite(hN)) return hh;
        const d = new Date(
          Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), hN, minN, 0),
        );
        return fmt.format(d);
      });
      return `${parts.join(", ")}${tz ? " " + tz : ""}`;
    }
  }

  // For range/step expressions, show ET start (e.g., "6:00 AM EDT every 10 min")
  if (/^\d+-\d+$/.test(cron.hour) && /^\*\/\d+$/.test(cron.minute)) {
    const step = cron.minute.match(/^\*\/(\d+)$/)?.[1] ?? "?";
    return `${single} every ${step} min`;
  }

  return single;
}
