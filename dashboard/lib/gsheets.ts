// Create a Google Sheet from row data and return its URL. The service account has
// NO personal Drive (storage quota 0), so the file MUST be created inside a Shared
// Drive (parents + supportsAllDrives) — a plain Sheets `spreadsheets.create` or a
// My-Drive create 403s. Mirrors the raw-fetch + googleAccessToken pattern in
// lib/sheets.ts (no googleapis dependency). Used by the research app's Naming
// Exercise "Export to Google Sheet" via the internal endpoint (research holds no
// Google creds; admin owns the SA).

import { googleAccessToken } from "./google-auth";

// "Snagged Pipeline" shared drive (same one scripts/gdrive.mjs writes to). The SA
// is a member, so it can create content here even without personal Drive quota.
const SHARED_DRIVE_ID = process.env.PIPELINE_SHARED_DRIVE_ID || "0ACKJ-QAwIhwLUk9PVA";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export type SheetResult = { url: string; spreadsheetId: string; shareWarning?: string };

export async function createSheetInSharedDrive(opts: {
  title: string;
  values: (string | number)[][]; // row 0 = header
  shareWith?: string; // email to grant writer access
  boldHeader?: boolean;
}): Promise<SheetResult> {
  const title = (opts.title || "Export").slice(0, 200);
  const values = Array.isArray(opts.values) ? opts.values : [];

  // 1) Create the spreadsheet file INSIDE the shared drive (Drive API).
  const driveToken = await googleAccessToken(DRIVE_SCOPE);
  const createRes = await fetch(
    "https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${driveToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [SHARED_DRIVE_ID],
      }),
    },
  );
  if (!createRes.ok) {
    throw new Error(`Drive create failed ${createRes.status}: ${(await createRes.text()).slice(0, 300)}`);
  }
  const { id: spreadsheetId } = (await createRes.json()) as { id: string };

  // 2) Write the rows (Sheets API). A fresh spreadsheet's first tab is gid 0.
  const sheetsToken = await googleAccessToken(SHEETS_SCOPE);
  if (values.length) {
    const putRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A1?valueInputOption=RAW`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${sheetsToken}`, "content-type": "application/json" },
        body: JSON.stringify({ values }),
      },
    );
    if (!putRes.ok) throw new Error(`Sheets write failed ${putRes.status}: ${(await putRes.text()).slice(0, 300)}`);
  }

  // 3) Bold the header row (best-effort, cosmetic).
  if (opts.boldHeader !== false && values.length) {
    try {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sheetsToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              repeatCell: {
                range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
                cell: { userEnteredFormat: { textFormat: { bold: true } } },
                fields: "userEnteredFormat.textFormat.bold",
              },
            },
          ],
        }),
      });
    } catch {
      /* cosmetic — ignore */
    }
  }

  // 4) Share to the requester as writer (best-effort). The file lives in a shared
  //    drive, but an explicit grant guarantees the person can open it.
  let shareWarning: string | undefined;
  const email = (opts.shareWith || "").trim();
  if (email) {
    try {
      const permRes = await fetch(
        `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${driveToken}`, "content-type": "application/json" },
          body: JSON.stringify({ role: "writer", type: "user", emailAddress: email }),
        },
      );
      if (!permRes.ok) shareWarning = `Sheet created but sharing to ${email} failed (${permRes.status}).`;
    } catch (e) {
      shareWarning = `Sheet created but sharing to ${email} failed (${(e as Error).message}).`;
    }
  }

  return { url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`, spreadsheetId, shareWarning };
}
