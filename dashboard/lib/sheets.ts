// Google Sheets (read-only) — server-only. Same service account as GA4, granted
// Viewer on the target sheet. Used by the revenue report (the Snagged Domain
// Tracker). Returns the raw value matrix; callers map columns by header.

import { googleAccessToken } from "./google-auth";

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
// Write scope — only used by the Client Domain corpus mirror, which rewrites the
// "Client Domain Names" tab. The target workbook must be shared to the SA with
// EDIT (Sheets delegation isn't authorized, so it's a direct share).
const WRITE_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export async function getSheetValues(sheetId: string, range: string): Promise<string[][]> {
  const token = await googleAccessToken(SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { values?: string[][] };
  return j.values || [];
}

// Spreadsheet title + the list of tab (sheet) titles. Used to walk every tab of
// a pitch-exercise workbook without hardcoding tab names.
export async function getSheetMeta(sheetId: string): Promise<{ title: string; tabs: string[] }> {
  const token = await googleAccessToken(SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}?fields=properties.title,sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets meta ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { properties?: { title?: string }; sheets?: { properties?: { title?: string } }[] };
  return {
    title: j.properties?.title || "",
    tabs: (j.sheets || []).map((s) => s.properties?.title || "").filter(Boolean),
  };
}

/** Clear a range's values (keeps formatting). */
export async function clearSheetRange(sheetId: string, range: string): Promise<void> {
  const token = await googleAccessToken(WRITE_SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}:clear`;
  const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets clear ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Overwrite a range with a value matrix (RAW input). Caller sizes the range. */
export async function writeSheetRange(sheetId: string, range: string, values: (string | number | null)[][]): Promise<void> {
  const token = await googleAccessToken(WRITE_SCOPE);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ range, majorDimension: "ROWS", values }),
  });
  if (!res.ok) throw new Error(`Sheets write ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
