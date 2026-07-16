// Snagged Domain Tracker sources: Payments + Master Txns List tabs.
// These are the NON-NEGOTIABLE sources (spec §19) — every domain here must land in
// the corpus. Reuses the same SA + sheet the sales-comps endpoint already reads.

import { getSheetValues } from "../../sheets";
import { extractApexes } from "../canonical";
import type { RawHit } from "../types";

const TRACKER_ID = process.env.SNAGGED_TRACKER_SHEET_ID || "1TVAJ2ef_rM03pHZ9rq8C3W4BgyiSBiOc5j7jAbFzGTA";

const cell = (row: string[], i: number): string => (row[i] || "").trim();

/** Join labeled parts, dropping empties, into a single tagged note block. */
function note(tag: string, parts: [string, string][]): string {
  const body = parts.filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join(" ");
  return body ? `${tag} ${body}` : tag;
}

// Payments!A2:Q — A domain(s), C confirmed, D anticipated, F client-paid date,
// K method, L status, M buy/sale, N lead (client), O 3rd party, Q comments.
export async function readPaymentsHits(): Promise<RawHit[]> {
  const rows = await getSheetValues(TRACKER_ID, "Payments!A2:Q");
  const hits: RawHit[] = [];
  for (const row of rows) {
    const apexes = extractApexes(cell(row, 0));
    if (!apexes.length) continue;
    const client = cell(row, 13); // N: Lead
    const date = cell(row, 5) || cell(row, 2) || cell(row, 3); // paid → confirmed → anticipated
    const n = note("[Payments]", [
      ["Status", cell(row, 11)],
      ["Buy/Sale", cell(row, 12)],
      ["Confirmed", cell(row, 2)],
      ["Paid", cell(row, 5)],
      ["Method", cell(row, 10)],
      ["3rdParty", cell(row, 14)],
      ["Comments", cell(row, 16)],
    ]);
    for (const domain of apexes) hits.push({ domain, client: client || null, source: "[Payments]", note: n, date: date || null });
  }
  return hits;
}

// 'Master Txns List'!A2:H — A date, B domain, C price, H notes.
export async function readMasterTxnsHits(): Promise<RawHit[]> {
  const rows = await getSheetValues(TRACKER_ID, "'Master Txns List'!A2:H");
  const hits: RawHit[] = [];
  for (const row of rows) {
    const apexes = extractApexes(cell(row, 1)); // B: Domain Name
    if (!apexes.length) continue;
    const date = cell(row, 0); // A: Date
    const n = note("[Master Txns List]", [
      ["Date", cell(row, 0)],
      ["Price", cell(row, 2)],
      ["Notes", cell(row, 7)],
    ]);
    // No natural counterparty on this tab — use the recommended placeholder label.
    for (const domain of apexes) hits.push({ domain, client: "Snagged Master Txns", source: "[Master Txns List]", note: n, date: date || null });
  }
  return hits;
}
