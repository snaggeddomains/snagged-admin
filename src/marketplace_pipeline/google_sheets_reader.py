"""Read a Google Sheet tab as list[dict].

Uses the same GOOGLE_SERVICE_ACCOUNT_JSON service-account auth as
publishers/sheets.py, but read-only. The sheet must be shared with the
service-account email (Viewer permission).

Returns rows keyed by the header row. Empty rows are skipped. Cells
are stringified and stripped — caller is responsible for parsing
prices / numbers / boolean-ish values per its own column conventions.
"""
from __future__ import annotations

import json
import os
from typing import Any

SCOPES_READONLY = ["https://www.googleapis.com/auth/spreadsheets.readonly"]


def _credentials():
    from google.oauth2.service_account import Credentials

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE must be set"
        )
    return Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES_READONLY)


def _service():
    from googleapiclient.discovery import build

    return build("sheets", "v4", credentials=_credentials(), cache_discovery=False)


def read_tab_as_dicts(spreadsheet_id: str, tab_name: str) -> list[dict[str, str]]:
    """Read every row from a tab; return as list of dicts keyed by header row.

    Empty rows (where every cell is blank) are skipped. Headers are
    stripped of whitespace. Trailing columns missing from a row are
    treated as empty strings, so dict access by header is always safe.
    """
    svc = _service()
    res = (
        svc.spreadsheets()
        .values()
        .get(spreadsheetId=spreadsheet_id, range=f"'{tab_name}'")
        .execute()
    )
    values = res.get("values", [])
    if not values:
        return []
    headers = [(h or "").strip() for h in values[0]]
    out: list[dict[str, str]] = []
    for row in values[1:]:
        padded = list(row) + [""] * (len(headers) - len(row))
        d = {h: str(padded[i]).strip() for i, h in enumerate(headers) if h}
        if any(v for v in d.values()):
            out.append(d)
    return out
