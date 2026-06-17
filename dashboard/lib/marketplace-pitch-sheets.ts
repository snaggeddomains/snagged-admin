// Naming-exercise pitches — the Google Sheets where we pitch a CLIENT a curated
// list of candidate domains (one workbook per engagement). When one of OUR
// for-sale domains appears in a client's exercise sheet, that's a proactive
// pitch of that domain to that client — surfaced under "Pitched to buyers" in
// the marketplace deal report.
//
// SOURCING: a self-serve **index sheet** (the "Pitch Exercises Index") maps each
// engagement's workbook -> client. Add an engagement by adding a row there — no
// code change. Columns: `Sheet URL | Client | Active?` (Client optional, falls
// back to the workbook title; Active? = no/false/paused to pause without
// deleting). The sheets are read with the same service account the rest of the
// report uses (plain SA token, no impersonation); the index AND each exercise
// workbook must be shared with
// marketplace-pipeline@snagged-pipeline.iam.gserviceaccount.com (or link-shared).
// If the index is unreadable we fall back to FALLBACK_EXERCISES so the report
// never goes blank.
//
// MATCHING is EXACT-DOMAIN. Tabs vary in shape (header rows, headerless "Grant
// Picks", an SLD/TLD split tab), so we don't trust column positions — we scan
// every cell of every row for a domain token (and reconstruct sld+tld splits),
// then keep the row's price/quote + note when the exact domain matches.

import { getSheetValues, getSheetMeta } from "./sheets";

export type PitchExercise = {
  client: string; // who we pitched (the engagement)
  description: string | null; // color on the type of company (from the index)
  paused: boolean; // the index marked this engagement Active?=no — a past/closed pitch
  sheetTitle: string; // workbook title
  tab: string; // which tab the domain was found on
  url: string; // link to the workbook
  price: string | null; // asking / quote, if the row had one
  note: string | null; // adjacent comment/notes, if any
};

// The index sheet (owned by Rob, shared to the SA). Override via env.
const INDEX_SHEET_ID = process.env.PITCH_INDEX_SHEET_ID || "1vIcs49EDtWOlCQuUKC0_B-sUQE-1M1ZEovJ9-mW-siA";

// Used only when the index sheet can't be read — keeps the report alive.
const FALLBACK_EXERCISES: ExerciseRow[] = [
  { id: "1KEmJml9MQlooHWkIaTGqa9ZE7TUokkC1sFZoYyLSOts", client: "Raycast", description: null, paused: false },
  { id: "14JPhUL3fWZ-W_HGDu3Fd4ZCorvgXBxs-FszAUgC_Wlc", client: "Timeglass", description: null, paused: false },
];

const SHEET_ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;
const PAUSED = new Set(["no", "false", "off", "paused", "inactive", "0", "n"]);
function extractSheetId(s: string): string | null {
  const v = (s || "").trim();
  const m = SHEET_ID_RE.exec(v);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{30,}$/.test(v) ? v : null; // tolerate a bare id
}

// Read the registry from the index sheet (5-min in-process cache). Each row is
// `Sheet URL | Client | Client Description | Active?`. Unparseable URLs are
// skipped; a paused (Active?=no) row is KEPT but flagged — the per-domain deal
// report shows paused engagements (a historical pitch record), while the weekly
// pitch-scan filters them out (see allExerciseDomains).
type ExerciseRow = { id: string; client: string; description: string | null; paused: boolean };
let _registry: { at: number; rows: ExerciseRow[] } | null = null;
async function getExercises(): Promise<ExerciseRow[]> {
  if (_registry && Date.now() - _registry.at < 5 * 60_000) return _registry.rows;
  try {
    const rows = await getSheetValues(INDEX_SHEET_ID, "Exercises!A2:D200");
    const out: ExerciseRow[] = [];
    for (const r of rows) {
      const id = extractSheetId(r[0] || "");
      if (!id) continue;
      const paused = PAUSED.has((r[3] || "yes").trim().toLowerCase());
      out.push({ id, client: (r[1] || "").trim(), description: (r[2] || "").trim() || null, paused });
    }
    if (out.length) {
      _registry = { at: Date.now(), rows: out };
      return out;
    }
  } catch {
    // index unreadable — fall through to the hardcoded fallback
  }
  return FALLBACK_EXERCISES;
}

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

// Every domain currently tracked across ALL registered exercise sheets — the set
// the weekly pitch-scan diffs against to find email pitches not yet on a sheet.
// Fail-soft per workbook/tab; returns lowercased bare domains.
export async function allExerciseDomains(): Promise<Set<string>> {
  const out = new Set<string>();
  // Pitch-scan only tracks ACTIVE engagements — a paused exercise shouldn't keep
  // a re-pitched domain out of the "add to a sheet" suggestions.
  const exercises = (await getExercises()).filter((e) => !e.paused);
  await Promise.all(
    exercises.map(async ({ id }) => {
      let meta: { title: string; tabs: string[] };
      try {
        meta = await getSheetMeta(id);
      } catch {
        return;
      }
      for (const tab of meta.tabs) {
        let rows: string[][] = [];
        try {
          rows = await getSheetValues(id, `${tab}!A1:Z2000`);
        } catch {
          continue;
        }
        for (const cells of rows) for (const d of rowDomains(cells)) out.add(d);
      }
    }),
  );
  return out;
}

// Find every pitch-exercise the given domain appears in (exact match). Fail-soft
// per workbook/tab so one unreadable sheet never sinks the report.
export async function findPitchExercises(domain: string): Promise<PitchExercise[]> {
  const target = norm(domain);
  if (!target) return [];
  const found: PitchExercise[] = [];
  const exercises = await getExercises();
  await Promise.all(
    exercises.map(async ({ id, client, description, paused }) => {
      let meta: { title: string; tabs: string[] };
      try {
        meta = await getSheetMeta(id);
      } catch {
        return; // sheet not shared / unreadable — skip silently
      }
      const clientName = client || meta.title; // index Client is optional
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
          found.push({ client: clientName, description, paused, sheetTitle: meta.title, tab, url: sheetUrl(id), price, note });
          break; // one credit per (client, tab) is enough
        }
      }
    }),
  );
  // De-dupe to one row per client (a domain can recur across a client's tabs);
  // prefer an active engagement, then the richest (with a price/note).
  const byClient = new Map<string, PitchExercise>();
  for (const e of found) {
    const ex = byClient.get(e.client);
    if (!ex || (ex.paused && !e.paused) || (!ex.price && e.price) || (!ex.note && e.note)) byClient.set(e.client, e);
  }
  // Active engagements first, then alphabetical.
  return [...byClient.values()].sort((a, b) => Number(a.paused) - Number(b.paused) || a.client.localeCompare(b.client));
}
