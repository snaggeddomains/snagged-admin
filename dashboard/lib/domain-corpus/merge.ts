// Merge upstream hits into one deduped record per canonical apex, and finalize the
// output row (spec §6–§11). Pure functions — no I/O.

import { splitApex } from "./canonical";
import type { RawHit, CorpusRecord, CorpusRow, ExistingMeta } from "./types";

const NOTES_CAP = 8000; // stay well under Google Sheets' ~50k cell limit

/** Parse a loose source date string to an ISO date (YYYY-MM-DD), or null. */
export function parseFlexibleDate(raw: string | null | undefined): string | null {
  const s = String(raw || "").trim();
  if (!s) return null;
  // Already ISO-ish.
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // US M/D/Y or M-D-Y (2- or 4-digit year).
  const us = s.match(/\b(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})\b/);
  if (us) {
    let [, mo, d, y] = us;
    let year = Number(y);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const mm = String(Math.min(12, Math.max(1, Number(mo)))).padStart(2, "0");
    const dd = String(Math.min(31, Math.max(1, Number(d)))).padStart(2, "0");
    if (year >= 1990 && year <= 2100) return `${year}-${mm}-${dd}`;
  }
  return null;
}

/** epoch-ms → ISO date. */
export function isoFromEpoch(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's date (UTC) as ISO. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add one hit to the map (creates the record on first sight of the apex). */
export function mergeHit(map: Map<string, CorpusRecord>, hit: RawHit): void {
  const parts = splitApex(hit.domain);
  if (!parts) return;
  const key = parts.apex;
  let rec = map.get(key);
  if (!rec) {
    rec = { domain: key, sld: parts.sld, tld: parts.tld, clients: [], sources: [], notes: [], dates: [] };
    map.set(key, rec);
  }
  const client = (hit.client || "").trim();
  if (client && !rec.clients.includes(client)) rec.clients.push(client);
  if (hit.source && !rec.sources.includes(hit.source)) rec.sources.push(hit.source);
  const note = (hit.note || "").trim();
  if (note && !rec.notes.includes(note)) rec.notes.push(note);
  const d = parseFlexibleDate(hit.date);
  if (d && !rec.dates.includes(d)) rec.dates.push(d);
}

/**
 * Finalize a record into the output row. `existing` (from the current table) is
 * preserved when present: Date Added stays stable across rebuilds (spec §11), and
 * first_ingested_at keeps the ORIGINAL day we first wrote the row — so a row is
 * "net-new" (first_ingested_at === today) only on the run that first added it.
 */
export function finalizeRecord(rec: CorpusRecord, existing: ExistingMeta | null): CorpusRow {
  const dates = [...rec.dates].sort(); // ascending ISO
  const first = dates[0] || null;
  const last = dates.length ? dates[dates.length - 1] : null;
  const clients = [...rec.clients].sort();
  const sources = [...rec.sources].sort();
  let notes = rec.notes.join("\n") || null;
  if (notes && notes.length > NOTES_CAP) notes = notes.slice(0, NOTES_CAP - 1) + "…";
  const today = todayISO();
  return {
    domain: rec.domain,
    sld: rec.sld,
    tld: rec.tld,
    clients,
    sources,
    notes,
    last_contact_date: last,
    first_source_date: first,
    date_added: existing?.date_added || first || today,
    first_ingested_at: existing?.first_ingested_at || today,
  };
}
