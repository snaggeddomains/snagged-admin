#!/usr/bin/env python3
"""One-shot: load a brandables CSV and publish it to a NEW Google Sheet,
shared with the requested owner. Uses the pipeline service account
(GOOGLE_SERVICE_ACCOUNT_JSON) — needs Drive + Sheets scopes, so it runs in CI.

Usage:
  GOOGLE_SERVICE_ACCOUNT_JSON=... python3 scripts/make_brand_sheet.py \
      --csv data/brandables.csv --title "Brandable Made-Up .coms" \
      --share rob@snagged.com
"""
from __future__ import annotations

import argparse
import csv
import json
import os

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def _creds():
    from google.oauth2.service_account import Credentials

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise SystemExit("GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE must be set")
    return Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES)


def _read_csv(path: str) -> list[list[str]]:
    with open(path, newline="") as f:
        return [row for row in csv.reader(f)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", action="append", required=True,
                    help="path to a CSV (repeatable -> one tab per CSV)")
    ap.add_argument("--tab", action="append", default=[],
                    help="tab name per --csv (same order)")
    ap.add_argument("--title", required=True)
    ap.add_argument("--spreadsheet-id", default="",
                    help="update this EXISTING spreadsheet in place (clear+rewrite "
                         "tabs) instead of creating a new one")
    ap.add_argument("--folder", default=os.environ.get("DRIVE_FOLDER_ID", ""),
                    help="Drive folder id to create the sheet in (SA must have "
                         "write access; avoids the SA My-Drive quota 403)")
    ap.add_argument("--share", action="append", default=[],
                    help="email(s) to share as writer")
    args = ap.parse_args()

    from googleapiclient.discovery import build

    creds = _creds()
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)

    tabs = args.tab or [f"Sheet{i+1}" for i in range(len(args.csv))]

    if args.spreadsheet_id:
        # Update the existing sheet in place: ensure every target tab exists +
        # clear it (so a shorter list doesn't leave stale rows behind).
        ssid = args.spreadsheet_id
        meta = sheets.spreadsheets().get(spreadsheetId=ssid).execute()
        url = meta.get("spreadsheetUrl") or f"https://docs.google.com/spreadsheets/d/{ssid}/edit"
        existing = {s["properties"]["title"] for s in meta["sheets"]}
        addreqs = [{"addSheet": {"properties": {"title": t}}}
                   for t in tabs if t not in existing]
        if addreqs:
            sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": addreqs}).execute()
            meta = sheets.spreadsheets().get(spreadsheetId=ssid).execute()
        # drop any leftover tab not in the target set (dedicated sheet — keep it clean)
        delreqs = [{"deleteSheet": {"sheetId": s["properties"]["sheetId"]}}
                   for s in meta["sheets"] if s["properties"]["title"] not in tabs]
        if delreqs:
            sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": delreqs}).execute()
        for t in tabs:
            sheets.spreadsheets().values().clear(spreadsheetId=ssid, range=t).execute()
    elif args.folder:
        # Create inside a folder the SA can write to (service accounts have no
        # personal My-Drive quota, so a bare spreadsheets.create() 403s).
        meta = drive.files().create(
            body={"name": args.title,
                  "mimeType": "application/vnd.google-apps.spreadsheet",
                  "parents": [args.folder]},
            fields="id,webViewLink",
            supportsAllDrives=True,
        ).execute()
        ssid = meta["id"]
        url = meta.get("webViewLink") or f"https://docs.google.com/spreadsheets/d/{ssid}/edit"
        # rename the default first tab to tabs[0], add the rest
        m0 = sheets.spreadsheets().get(spreadsheetId=ssid).execute()
        first_id = m0["sheets"][0]["properties"]["sheetId"]
        reqs = [{"updateSheetProperties": {
            "properties": {"sheetId": first_id, "title": tabs[0]},
            "fields": "title"}}]
        for t in tabs[1:]:
            reqs.append({"addSheet": {"properties": {"title": t}}})
        sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": reqs}).execute()
    else:
        spreadsheet = sheets.spreadsheets().create(body={
            "properties": {"title": args.title},
            "sheets": [{"properties": {"title": tabs[0]}}],
        }).execute()
        ssid = spreadsheet["spreadsheetId"]
        url = spreadsheet["spreadsheetUrl"]
        if len(tabs) > 1:
            sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": [
                {"addSheet": {"properties": {"title": t}}} for t in tabs[1:]]}).execute()

    for path, tab in zip(args.csv, tabs):
        rows = _read_csv(path)
        sheets.spreadsheets().values().update(
            spreadsheetId=ssid,
            range=f"{tab}!A1",
            valueInputOption="RAW",
            body={"values": rows},
        ).execute()
        # bold + freeze the header row
        meta = sheets.spreadsheets().get(spreadsheetId=ssid).execute()
        sid = next(s["properties"]["sheetId"] for s in meta["sheets"]
                   if s["properties"]["title"] == tab)
        sheets.spreadsheets().batchUpdate(spreadsheetId=ssid, body={"requests": [
            {"updateSheetProperties": {
                "properties": {"sheetId": sid, "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount"}},
            {"repeatCell": {
                "range": {"sheetId": sid, "startRowIndex": 0, "endRowIndex": 1},
                "cell": {"userEnteredFormat": {"textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold"}},
        ]}).execute()
        print(f"wrote {len(rows)-1} rows to tab '{tab}'")

    # only (re)share on first creation — an in-place update is already shared
    for email in (args.share if not args.spreadsheet_id else []):
        drive.permissions().create(
            fileId=ssid,
            sendNotificationEmail=True,
            supportsAllDrives=True,
            body={"type": "user", "role": "writer", "emailAddress": email},
        ).execute()
        print(f"shared with {email}")

    print(f"SPREADSHEET_URL={url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
