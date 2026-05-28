"""Auctions sheet writer.

Writes consolidated auction rows to the auctions sheet (5-column layout:
end_time_utc, time_left, domain, price, platform). Behavior matches the
legacy push_auctions_to_sheet.py:

  - Existing rows below A2 are read.
  - New rows are prepended; the sheet acts as a growing log.
  - We additionally dedup by (domain, end_time_utc) so re-running a
    workflow doesn't duplicate the same auction. Legacy did not dedup;
    this is a strict improvement.
  - Rows are written back via clear + update at A2.

Header row (row 1) is NOT touched by this writer — the user manages it.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SHEET_RANGE = "Sheet1!A2:E"
WRITE_RANGE = "Sheet1!A2"

SHEET_COLUMNS = ("end_time_utc", "time_left", "domain", "price", "platform")


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
    return Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES)


def _service():
    from googleapiclient.discovery import build

    return build("sheets", "v4", credentials=_credentials(), cache_discovery=False)


def _read_existing(service, spreadsheet_id: str) -> list[list[Any]]:
    res = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=SHEET_RANGE,
    ).execute()
    return res.get("values", [])


def format_time_left(end_utc: datetime, *, now: datetime | None = None) -> str:
    """Human-readable countdown like '2d 3h' or '4h 12m' or 'soon'."""
    now = now or datetime.now(timezone.utc)
    if end_utc.tzinfo is None:
        end_utc = end_utc.replace(tzinfo=timezone.utc)
    delta = end_utc - now
    secs = int(delta.total_seconds())
    if secs <= 0:
        return "ended"
    days, rem = divmod(secs, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    if days >= 1:
        return f"{days}d {hours}h"
    if hours >= 1:
        return f"{hours}h {minutes}m"
    if minutes >= 1:
        return f"{minutes}m"
    return "soon"


def row_from_listing(listing: dict[str, Any], *, now: datetime | None = None) -> list[Any]:
    """Normalize a single AuctionListing-shaped dict into the 5-column row."""
    end = listing["end_time_utc"]
    if isinstance(end, str):
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
    elif isinstance(end, datetime):
        end_dt = end
    else:
        raise ValueError(f"end_time_utc must be str or datetime; got {type(end)}")
    if end_dt.tzinfo is None:
        end_dt = end_dt.replace(tzinfo=timezone.utc)

    end_str = end_dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return [
        end_str,
        format_time_left(end_dt, now=now),
        listing["domain"],
        listing.get("price") if listing.get("price") is not None else "",
        listing.get("platform", ""),
    ]


def _dedup_key(row: list[Any]) -> tuple[str, str]:
    """Identify a row by (domain, end_time_utc)."""
    return (str(row[2]).strip().lower(), str(row[0]).strip())


def write(
    *,
    spreadsheet_id: str,
    new_rows: list[list[Any]],
    service: Any = None,
) -> dict[str, int]:
    """Prepend new auction rows to the sheet, deduping (domain, end) against existing.

    Returns stats: {existing, added, deduped, total_after}.
    """
    svc = service or _service()
    existing = _read_existing(svc, spreadsheet_id)
    existing_keys = {_dedup_key(r) for r in existing if len(r) >= 3}

    deduped_new: list[list[Any]] = []
    skipped = 0
    for r in new_rows:
        if _dedup_key(r) in existing_keys:
            skipped += 1
            continue
        deduped_new.append(r)
        existing_keys.add(_dedup_key(r))

    combined = deduped_new + existing

    svc.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id, range=SHEET_RANGE,
    ).execute()
    if combined:
        svc.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=WRITE_RANGE,
            valueInputOption="USER_ENTERED",
            body={"values": combined},
        ).execute()

    return {
        "existing": len(existing),
        "added": len(deduped_new),
        "deduped": skipped,
        "total_after": len(combined),
    }
