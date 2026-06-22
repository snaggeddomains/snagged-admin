#!/usr/bin/env python3
"""Read-only dump of a Google Sheet via the pipeline service account.

Prints the tab list, then for the target tab (by --gid or --tab, else all tabs)
dumps both the FORMATTED values and the FORMULAS so cross-tab/SUM references can
be traced. Used to inspect sheets shared with the SA from CI (creds live there).

  GOOGLE_SERVICE_ACCOUNT_JSON=... python3 scripts/read_sheet.py --id <id> --gid <gid>
"""
from __future__ import annotations
import argparse, json, os

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
MAX_ROWS = 300
MAX_COLS = 30


def _creds():
    from google.oauth2.service_account import Credentials
    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise SystemExit("GOOGLE_SERVICE_ACCOUNT_JSON must be set")
    return Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES)


def _grid(svc, ssid, title, render):
    res = svc.spreadsheets().values().get(
        spreadsheetId=ssid, range=f"'{title}'",
        valueRenderOption=render, dateTimeRenderOption="FORMATTED_STRING",
    ).execute()
    return res.get("values", [])


def _dump(title, values, formulas):
    print(f"\n===== TAB: {title} =====")
    for r, row in enumerate(values[:MAX_ROWS], 1):
        cells = [str(c) for c in row[:MAX_COLS]]
        if any(c.strip() for c in cells):
            print(f"R{r}\t" + "\t".join(cells))
    print(f"----- FORMULAS in {title} -----")
    for r, row in enumerate(formulas[:MAX_ROWS], 1):
        for c, val in enumerate(row[:MAX_COLS], 1):
            s = str(val)
            if s.startswith("="):
                col = ""
                cc = c
                while cc:
                    cc, rem = divmod(cc - 1, 26)
                    col = chr(65 + rem) + col
                print(f"{col}{r}\t{s}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", required=True)
    ap.add_argument("--gid", type=int, default=None)
    ap.add_argument("--tab", default=None)
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    from googleapiclient.discovery import build
    svc = build("sheets", "v4", credentials=_creds(), cache_discovery=False)
    meta = svc.spreadsheets().get(spreadsheetId=args.id).execute()
    print(f"TITLE: {meta.get('properties', {}).get('title', '')}")
    print("TABS (title | gid | rows x cols):")
    sheets = meta.get("sheets", [])
    for s in sheets:
        p = s["properties"]; g = p.get("gridProperties", {})
        print(f"  - {p['title']} | {p['sheetId']} | {g.get('rowCount')}x{g.get('columnCount')}")

    targets = []
    for s in sheets:
        p = s["properties"]
        if args.all or (args.gid is not None and p["sheetId"] == args.gid) or (args.tab and p["title"] == args.tab):
            targets.append(p["title"])
    if not targets and args.gid is None and not args.tab:
        targets = [s["properties"]["title"] for s in sheets]

    for title in targets:
        try:
            _dump(title, _grid(svc, args.id, title, "FORMATTED_VALUE"),
                  _grid(svc, args.id, title, "FORMULA"))
        except Exception as e:
            print(f"  (failed to read '{title}': {e})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
