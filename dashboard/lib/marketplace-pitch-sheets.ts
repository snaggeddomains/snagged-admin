// Naming-exercise pitches — the Google Sheets where we pitch a CLIENT a curated
// list of candidate domains (one workbook per engagement). When one of OUR
// for-sale domains appears in a client's exercise sheet, that's a proactive
// pitch of that domain to that client — surfaced under "Pitched to buyers" in
// the marketplace deal report.
//
// SOURCING: a small explicit registry (sheet id -> client). Add an engagement by
// adding a line here. The sheets are read with the same service account the rest
// of the report uses (plain SA token, no impersonation); each must be shared with
// marketplace-pipeline@snagged-pipeline.iam.gserviceaccount.com (or link-shared).
//
// MATCHING is EXACT-DOMAIN. Tabs vary in shape (header rows, headerless "Grant
// Picks", an SLD/TLD split tab), so we don't trust column positions — we scan
// every cell of every row for a domain token (and reconstruct sld+tld splits),
// then keep the row's price/quote + note when the exact domain matches.

import { getSheetValues, getSheetMeta } from "./sheets";

export type PitchExercise = {
  client: string; // who we pitched (the engagement)
  sheetTitle: string; // workbook title
  tab: string; // which tab the domain was found on
  url: string; // link to the workbook
  price: string | null; // asking / quote, if the row had one
  note: string | null; // adjacent comment/notes, if any
};

// The registry. `client` is explicit so we don't guess it from the title.
const EXERCISES: { id: string; client: string }[] = [
  { id: "1KEmJml9MQlooHWkIaTGqa9ZE7TUokkC1sFZoYyLSOts", client: "Raycast" },
  { id: "14JPhUL3fWZ-W_HGDu3Fd4ZCorvgXBxs-FszAUgC_Wlc", client: "Timeglass" },
];

const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+$/i;
const PRICE_HINT = /\$|min offer|tbd|\bk\b|\bquote\b|negotiat/i;
const norm = (s: string) => (s || "").trim().toLowerCase().replace(/^www\./, "");

// Every domain token a row could be pitching: any cell that's a bare domain,
// plus an SLD/TLD split across two adjacent cells (the "beam | app" tab).
function rowDomains(cells: string[]): Set<string> {
  const out = new Set<string>();
  const c = cells.map((x) => norm(x));
  for (let i = 0; i < c.length; i++) {
    if (DOMAIN_RE.test(c[i])) out.add(c[i]);
    // sld + tld split: "beam" | "app" -> beam.app (tld is a short alpha token).
    if (c[i] && /^[a-z0-9-]{1,40}$/.test(c[i]) && c[i + 1] && /^[a-z]{2,10}$/.test(c[i + 1]) && !c[i].includes(".")) {
      out.add(`${c[i]}.${c[i + 1]}`);
    }
  }
  return out;
}

// Pull a price/quote and a note from a matched row (best-effort, layout-agnostic).
function rowExtras(cells: string[], matched: string): { price: string | null; note: string | null } {
  const rest = cells.map((x) => (x || "").trim()).filter((x) => x && norm(x) !== matched && norm(x) !== matched.split(".")[0]);
  const price = rest.find((x) => PRICE_HINT.test(x) && x.length <= 40) || null;
  const note = rest.find((x) => x !== price && x.length > (price ? 0 : 3) && !DOMAIN_RE.test(norm(x))) || null;
  return { price: price || null, note: note && note !== price ? note.slice(0, 200) : null };
}

// Find every pitch-exercise the given domain appears in (exact match). Fail-soft
// per workbook/tab so one unreadable sheet never sinks the report.
export async function findPitchExercises(domain: string): Promise<PitchExercise[]> {
  const target = norm(domain);
  if (!target) return [];
  const found: PitchExercise[] = [];
  await Promise.all(
    EXERCISES.map(async ({ id, client }) => {
      let meta: { title: string; tabs: string[] };
      try {
        meta = await getSheetMeta(id);
      } catch {
        return; // sheet not shared / unreadable — skip silently
      }
      for (const tab of meta.tabs) {
        let rows: string[][] = [];
        try {
          rows = await getSheetValues(id, `${tab}!A1:Z2000`);
        } catch {
          continue;
        }
        for (const cells of rows) {
          if (!rowDomains(cells).has(target)) continue;
          const { price, note } = rowExtras(cells, target);
          found.push({ client, sheetTitle: meta.title, tab, url: sheetUrl(id), price, note });
          break; // one credit per (client, tab) is enough
        }
      }
    }),
  );
  // De-dupe to one row per client (a domain can recur across a client's tabs);
  // keep the richest (with a price/note).
  const byClient = new Map<string, PitchExercise>();
  for (const e of found) {
    const ex = byClient.get(e.client);
    if (!ex || (!ex.price && e.price) || (!ex.note && e.note)) byClient.set(e.client, e);
  }
  return [...byClient.values()].sort((a, b) => a.client.localeCompare(b.client));
}
