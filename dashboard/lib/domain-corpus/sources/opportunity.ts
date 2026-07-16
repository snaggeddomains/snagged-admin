// Full Opportunity sheet — pipeline / opportunity domains (spec §2.3). Column
// layout isn't fixed in the spec, so we map by HEADER name (row 1) and fall back to
// content-detection for the domain column (same tactic as the sales-comps endpoint).

import { getSheetValues } from "../../sheets";
import { extractApexes, canonicalApex } from "../canonical";
import type { RawHit } from "../types";

const OPP_ID = process.env.OPPORTUNITY_SHEET_ID || "1RE3Ab0fc0pHHKr066B5vC0XFRipIQ6qvVWp-v4BtCWA";
const RANGE = "Full Opportunity!A1:I"; // include the header row for column mapping

const norm = (s: string): string => String(s || "").trim().toLowerCase();

/** Index of the first header matching any of the given substrings, else -1. */
function findCol(headers: string[], needles: string[]): number {
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]);
    if (h && needles.some((n) => h.includes(n))) return i;
  }
  return -1;
}

/** Column whose cells are most domain-shaped (fallback when no "domain" header). */
function detectDomainCol(rows: string[][], width: number): number {
  let best = -1, bestScore = 0;
  for (let c = 0; c < width; c++) {
    let hits = 0, seen = 0;
    for (const row of rows.slice(0, 200)) {
      const v = (row[c] || "").trim();
      if (!v) continue;
      seen++;
      if (canonicalApex(v)) hits++;
    }
    const score = seen ? hits / seen : 0;
    if (hits >= 3 && score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

export async function readOpportunityHits(): Promise<RawHit[]> {
  const all = await getSheetValues(OPP_ID, RANGE);
  if (all.length < 2) return [];
  const headers = all[0] || [];
  const rows = all.slice(1);
  const width = Math.max(headers.length, ...rows.slice(0, 50).map((r) => r.length));

  let domainCol = findCol(headers, ["domain", "name"]);
  if (domainCol < 0) domainCol = detectDomainCol(rows, width);
  if (domainCol < 0) return [];

  const buyerCol = findCol(headers, ["buyer"]);
  const ownerCol = findCol(headers, ["owner", "seller"]);
  const statusCol = findCol(headers, ["status", "stage"]);
  const dateCol = findCol(headers, ["date"]);

  const cell = (row: string[], i: number): string => (i >= 0 ? (row[i] || "").trim() : "");
  const hits: RawHit[] = [];
  for (const row of rows) {
    const apexes = extractApexes(cell(row, domainCol));
    if (!apexes.length) continue;
    const buyer = cell(row, buyerCol);
    const owner = cell(row, ownerCol);
    const client = buyer || owner; // prefer the buyer as the contact label
    const n = ["[Full Opportunity]",
      cell(row, statusCol) ? `Status:${cell(row, statusCol)}` : "",
      buyer ? `Buyer:${buyer}` : "",
      owner ? `Owner:${owner}` : "",
    ].filter(Boolean).join(" ");
    const date = cell(row, dateCol);
    for (const domain of apexes) hits.push({ domain, client: client || null, source: "[Full Opportunity]", note: n, date: date || null });
  }
  return hits;
}
