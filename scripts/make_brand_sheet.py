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
    ap.add_argument("--share", action="append", default=[],
                    help="email(s) to share as writer")
    args = ap.parse_args()

    from googleapiclient.discovery import build

    creds = _creds()
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)

    tabs = args.tab or [f"Sheet{i+1}" for i in range(len(args.csv))]
    # create with the first tab, then add the rest
    spreadsheet = sheets.spreadsheets().create(body={
        "properties": {"title": args.title},
        "sheets": [{"properties": {"title": tabs[0]}}],
    }).execute()
    ssid = spreadsheet["spreadsheetId"]
    url = spreadsheet["spreadsheetUrl"]

    requests = []
    for t in tabs[1:]:
        requests.append({"addSheet": {"properties": {"title": t}}})
    if requests:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=ssid, body={"requests": requests}).execute()

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

    for email in args.share:
        drive.permissions().create(
            fileId=ssid,
            sendNotificationEmail=True,
            body={"type": "user", "role": "writer", "emailAddress": email},
        ).execute()
        print(f"shared with {email}")

    print(f"SPREADSHEET_URL={url}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
