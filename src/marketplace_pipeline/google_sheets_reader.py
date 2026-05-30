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


def list_tabs(spreadsheet_id: str) -> list[str]:
    """Return the visible tab titles in this workbook. Useful for diagnosing
    'tab not found' errors and for fuzzy lookups."""
    svc = _service()
    meta = svc.spreadsheets().get(spreadsheetId=spreadsheet_id).execute()
    return [s["properties"]["title"] for s in meta.get("sheets", [])]


def read_tab_as_dicts(spreadsheet_id: str, tab_name: str) -> list[dict[str, str]]:
    """Read every row from a tab; return as list of dicts keyed by header row.

    Empty rows (where every cell is blank) are skipped. Headers are
    stripped of whitespace. Trailing columns missing from a row are
    treated as empty strings, so dict access by header is always safe.

    The Sheets API accepts bare tab names as a range when you want the
    whole sheet. Single-quoting is only required for explicit A1-notation
    ranges with embedded spaces (e.g., "'Rob Purchases'!A1:Z"). Passing
    the bare name handles both 'SNAP' and 'Rob Purchases' correctly.

    On a 'range parse' error we raise with the list of actual tab names
    in the workbook so it's obvious whether we have the name wrong vs
    a real auth / sharing issue.
    """
    from googleapiclient.errors import HttpError

    svc = _service()
    try:
        res = (
            svc.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=tab_name)
            .execute()
        )
    except HttpError as e:
        # Range-parse errors usually mean the tab doesn't exist (or has a
        # different name than expected). Surface the actual list of tabs so
        # the caller can correct the config without round-tripping.
        try:
            available = list_tabs(spreadsheet_id)
        except Exception:
            available = ["<unable to list tabs>"]
        raise RuntimeError(
            f"Could not read tab {tab_name!r} from sheet {spreadsheet_id}. "
            f"Available tabs: {available}. "
            f"Original Sheets API error: {e}"
        ) from e

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
