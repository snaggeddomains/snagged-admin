"""Google service account auth smoke test.

Verifies the SA configured in GOOGLE_SERVICE_ACCOUNT_JSON (or
GOOGLE_SERVICE_ACCOUNT_FILE for local dev) can reach every Sheet, Doc, and
Drive folder the pipeline depends on. Does NOT write anything.

Run via:
    pipeline auth-check
or directly:
    python -m marketplace_pipeline.tools.auth_check
"""
from __future__ import annotations

import json
import os
import sys

SHEETS = {
    "snap_main":      "1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8",
    "atom_wholesale": "1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw",
    "auctions":       "1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks",
}
DOC_ID = "1-n-fiAOfTf9e5NaVSHCdgyNRTKdPuPBRx2A9XqwzczU"
DRIVE_FOLDERS = {
    "atom_dumps":      "1FFB8_8aTii5YQJheIQsJI0SqYRmFMg_4",
    "auction_uploads": "1vCnJb4iJeVJnLiRk4BwO7TEbRY16-Gta",
}

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
]


def _load_credentials():
    from google.oauth2.service_account import Credentials

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise RuntimeError(
            "Neither GOOGLE_SERVICE_ACCOUNT_JSON nor a readable "
            "GOOGLE_SERVICE_ACCOUNT_FILE is set."
        )
    info = json.loads(raw)
    return Credentials.from_service_account_info(info, scopes=SCOPES)


def _check_sheets(creds) -> int:
    from googleapiclient.discovery import build

    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)
    failures = 0
    for name, sheet_id in SHEETS.items():
        try:
            meta = svc.spreadsheets().get(
                spreadsheetId=sheet_id,
                fields="properties(title),sheets(properties(title))",
            ).execute()
            tabs = [s["properties"]["title"] for s in meta.get("sheets", [])]
            print(f"  OK   sheet {name:<16} '{meta['properties']['title']}'  tabs={tabs}")
        except Exception as e:
            print(f"  FAIL sheet {name:<16} {e!s}")
            failures += 1
    return failures


def _check_doc(creds) -> int:
    from googleapiclient.discovery import build

    svc = build("docs", "v1", credentials=creds, cache_discovery=False)
    try:
        meta = svc.documents().get(documentId=DOC_ID).execute()
        elements = len(meta.get("body", {}).get("content", []))
        print(f"  OK   doc   atom_wholesale  '{meta.get('title', '?')}'  ({elements} elements)")
        return 0
    except Exception as e:
        print(f"  FAIL doc   atom_wholesale  {e!s}")
        return 1


def _check_drive(creds) -> int:
    from googleapiclient.discovery import build

    svc = build("drive", "v3", credentials=creds, cache_discovery=False)
    failures = 0
    for name, folder_id in DRIVE_FOLDERS.items():
        try:
            res = svc.files().list(
                q=f"'{folder_id}' in parents and trashed=false",
                pageSize=5,
                fields="files(id,name)",
            ).execute()
            files = res.get("files", [])
            sample = ", ".join(f["name"] for f in files[:3]) or "(empty)"
            print(f"  OK   drive {name:<16} {len(files)} files visible  sample: {sample}")
        except Exception as e:
            print(f"  FAIL drive {name:<16} {e!s}")
            failures += 1
    return failures


def main() -> int:
    print("Google auth smoke test")
    print("=" * 50)
    try:
        creds = _load_credentials()
        print(f"Authenticated as: {creds.service_account_email}")
        print()
    except Exception as e:
        print(f"FAIL: could not load credentials -- {e}")
        return 1

    print("Sheets:")
    sf = _check_sheets(creds)
    print()
    print("Doc:")
    df = _check_doc(creds)
    print()
    print("Drive folders:")
    drf = _check_drive(creds)
    print()

    total_fail = sf + df + drf
    total = len(SHEETS) + 1 + len(DRIVE_FOLDERS)
    if total_fail == 0:
        print(f"PASS -- all {total} resources reachable.")
        return 0
    print(
        f"FAIL -- {total_fail}/{total} resources unreachable. "
        f"Most likely cause: missing share with {creds.service_account_email}"
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
