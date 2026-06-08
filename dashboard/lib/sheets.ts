// Google Sheets (read-only) — server-only. Same service account as GA4, granted
// Viewer on the target sheet. Used by the revenue report (the Snagged Domain
// Tracker). Returns the raw value matrix; callers map columns by header.

import { googleAccessToken } from "./google-auth";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export async function getSheetValues(sheetId: string, range: string): Promise<string[][]> {
  const token = await googleAccessToken(SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { values?: string[][] };
  return j.values || [];
}
