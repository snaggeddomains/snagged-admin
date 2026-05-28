"""Shared Google Sheets publisher with explicit row-ownership semantics.

Every source declares how it owns rows in a shared destination tab via one
of the OwnershipMode values. See
docs/domain-dumps-and-platform-workflows-spec.md section 9.1 and §13 of the
operational doc for the legacy behaviors these modes formalize.
"""
from __future__ import annotations

import json
import os
from enum import Enum
from typing import Any, Callable

SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]


class OwnershipMode(str, Enum):
    """How a source updates rows in a shared sheet tab."""

    REPLACE_SOURCE_ROWS = "replace_source_rows"
    """Drop this source's rows whose date != report_date, keep its today's
    rows (for re-run dedupe), preserve other-source rows. New incoming rows
    are deduped against today's existing rows by (domain, date) and prepended.
    Example: Namecheap BIN -> 'Today's New Listings'."""

    PREPEND_NEW_ROWS = "prepend_new_rows"
    """Insert new rows at the top under the header; existing rows pushed down.
    Example: Atom Wholesale doc ingest into 'Running' tab."""

    APPEND_IF_MISSING = "append_if_missing"
    """Append rows only for domains not already present in the sheet.
    Example: Atom net-new into 'Running Good Deals'."""

    REBUILD_OWNED_SLICE = "rebuild_owned_slice"
    """Drop all of this source's rows, replace with the current full slice;
    do NOT touch rows from other sources.
    Example: Afternic rebuild of 'Running Good Deals'."""


# ---------------------------------------------------------------------------
# Auth / service
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Sheet I/O primitives
# ---------------------------------------------------------------------------

def _read_tab(service, spreadsheet_id: str, tab: str) -> list[list[Any]]:
    res = service.spreadsheets().values().get(
        spreadsheetId=spreadsheet_id, range=f"'{tab}'!A:Z",
    ).execute()
    return res.get("values", [])


def _clear_and_write(service, spreadsheet_id: str, tab: str, rows: list[list[Any]]) -> None:
    service.spreadsheets().values().clear(
        spreadsheetId=spreadsheet_id, range=f"'{tab}'!A:Z",
    ).execute()
    if not rows:
        return
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab}'!A1",
        valueInputOption="USER_ENTERED",
        body={"values": rows},
    ).execute()


# ---------------------------------------------------------------------------
# REPLACE_SOURCE_ROWS (pure, easily testable)
# ---------------------------------------------------------------------------

def _replace_source_rows_impl(
    *,
    existing: list[list[Any]],
    source: str,
    report_date: str,
    new_rows: list[dict[str, Any]],
    source_column: str,
    date_column: str,
    default_header: list[str] | None,
) -> tuple[list[list[Any]], dict[str, int]]:
    """Pure transform — given the current sheet contents and incoming rows,
    return (final rows with header, stats)."""
    if existing:
        header = existing[0]
        data = existing[1:]
    elif default_header:
        header = list(default_header)
        data = []
    elif new_rows:
        header = list(new_rows[0].keys())
        data = []
    else:
        return [], {"removed": 0, "kept_today": 0, "added": 0, "total_after": 0}

    try:
        src_idx = header.index(source_column)
    except ValueError as e:
        raise ValueError(
            f"Sheet header missing required '{source_column}' column: {header}"
        ) from e
    try:
        date_idx = header.index(date_column)
    except ValueError as e:
        raise ValueError(
            f"Sheet header missing required '{date_column}' column: {header}"
        ) from e

    source_lc = source.lower()
    kept_other: list[list[Any]] = []
    kept_today: list[list[Any]] = []
    today_keys: set[tuple[str, str]] = set()
    removed = 0
    for row in data:
        if not row:
            continue
        padded = list(row) + [""] * (len(header) - len(row))
        domain = str(padded[0] or "").strip().lower()
        if not domain:
            continue
        row_source = str(padded[src_idx] or "").strip().lower()
        row_date = str(padded[date_idx] or "").strip()
        if row_source == source_lc:
            if row_date == report_date:
                today_keys.add((domain, row_date))
                kept_today.append(padded[: len(header)])
            else:
                removed += 1
        else:
            kept_other.append(padded[: len(header)])

    new_lists: list[list[Any]] = []
    for d in new_rows:
        row = [d.get(col, "") for col in header]
        domain = str(row[0]).strip().lower()
        row_date = str(row[date_idx]).strip()
        if (domain, row_date) in today_keys:
            continue
        new_lists.append(row)

    final = [list(header)] + new_lists + kept_today + kept_other
    stats = {
        "removed": removed,
        "kept_today": len(kept_today),
        "added": len(new_lists),
        "total_after": len(final) - 1,
    }
    return final, stats


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def _rebuild_owned_slice_impl(
    *,
    existing: list[list[Any]],
    new_rows: list[dict[str, Any]],
    owner_predicate: Callable[[dict[str, Any]], bool],
    default_header: list[str] | None,
) -> tuple[list[list[Any]], dict[str, int]]:
    """Pure transform — drop rows the owner_predicate identifies as ours,
    keep everything else, prepend our new rows."""
    if existing:
        header = existing[0]
        data = existing[1:]
    elif default_header:
        header = list(default_header)
        data = []
    elif new_rows:
        header = list(new_rows[0].keys())
        data = []
    else:
        return [], {"removed": 0, "added": 0, "preserved": 0, "total_after": 0}

    preserved: list[list[Any]] = []
    removed = 0
    for row in data:
        if not row:
            continue
        padded = list(row) + [""] * (len(header) - len(row))
        row_dict = dict(zip(header, padded))
        if owner_predicate(row_dict):
            removed += 1
        else:
            preserved.append(padded[: len(header)])

    new_lists = [[d.get(col, "") for col in header] for d in new_rows]
    final = [list(header)] + new_lists + preserved
    return final, {
        "removed": removed,
        "added": len(new_lists),
        "preserved": len(preserved),
        "total_after": len(final) - 1,
    }


def _append_if_missing_impl(
    service,
    spreadsheet_id: str,
    tab: str,
    *,
    existing: list[list[Any]],
    new_rows: list[dict[str, Any]],
    default_header: list[str] | None,
    key_column: str,
) -> dict[str, int]:
    """Append only rows whose `key_column` value isn't already in the tab.
    Uses spreadsheets.values.append rather than clear+update."""
    if not existing:
        if default_header:
            header = list(default_header)
        elif new_rows:
            header = list(new_rows[0].keys())
        else:
            return {"added": 0, "skipped": 0, "total_after": 0}
        # Write header first so the append below targets row 2
        service.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=f"'{tab}'!A1",
            valueInputOption="USER_ENTERED",
            body={"values": [header]},
        ).execute()
        existing_keys: set[str] = set()
    else:
        header = existing[0]
        try:
            key_idx = header.index(key_column)
        except ValueError as e:
            raise ValueError(
                f"Sheet header missing required '{key_column}' column: {header}"
            ) from e
        existing_keys = set()
        for row in existing[1:]:
            if row and len(row) > key_idx:
                k = str(row[key_idx]).strip().lower()
                if k:
                    existing_keys.add(k)

    to_append: list[list[Any]] = []
    skipped = 0
    for d in new_rows:
        k = str(d.get(key_column, "")).strip().lower()
        if not k or k in existing_keys:
            skipped += 1
            continue
        to_append.append([d.get(col, "") for col in header])
        existing_keys.add(k)

    if to_append:
        service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=f"'{tab}'!A2",
            valueInputOption="USER_ENTERED",
            insertDataOption="INSERT_ROWS",
            body={"values": to_append},
        ).execute()

    return {
        "added": len(to_append),
        "skipped": skipped,
        "total_after": (len(existing) - 1 if existing else 0) + len(to_append),
    }


def write_rows(
    *,
    spreadsheet_id: str,
    tab: str,
    mode: OwnershipMode,
    source: str,
    rows: list[dict[str, Any]],
    source_column: str = "source",
    date_column: str = "date_added",
    key_column: str = "domain",
    report_date: str | None = None,
    default_header: list[str] | None = None,
    owner_predicate: Callable[[dict[str, Any]], bool] | None = None,
    service: Any = None,
) -> dict[str, int]:
    """Write rows to a sheet tab according to the declared ownership mode.

    Args:
        spreadsheet_id: Google Sheet ID.
        tab: Tab name (no quoting needed).
        mode: One of the OwnershipMode values.
        source: Source label.
        rows: List of dicts; each dict's keys must include the sheet's header
            column names. Missing columns become "".
        source_column: Header name of the column that records the source.
            Used as the default predicate for owned rows (case-insensitive
            equality) when owner_predicate is not supplied.
        date_column: Header name of the column that records the row date.
        key_column: Header name of the column whose values must be unique
            (used by APPEND_IF_MISSING for the membership check).
        report_date: ISO date (YYYY-MM-DD). Required for REPLACE_SOURCE_ROWS.
        default_header: Header to use if the tab is empty.
        owner_predicate: Optional function `(row_dict) -> bool` returning True
            for rows that this source owns. Used by REBUILD_OWNED_SLICE when
            the source is identified by something other than equality on the
            source_column (e.g. legacy Running Good Deals identifies Afternic
            rows by a link prefix).
        service: Optional pre-built Google Sheets v4 service (for tests).
    """
    svc = service or _service()
    existing = _read_tab(svc, spreadsheet_id, tab)

    if mode == OwnershipMode.REPLACE_SOURCE_ROWS:
        if not report_date:
            raise ValueError("REPLACE_SOURCE_ROWS requires `report_date`")
        final, stats = _replace_source_rows_impl(
            existing=existing,
            source=source,
            report_date=report_date,
            new_rows=rows,
            source_column=source_column,
            date_column=date_column,
            default_header=default_header,
        )
        _clear_and_write(svc, spreadsheet_id, tab, final)
        return stats

    if mode == OwnershipMode.REBUILD_OWNED_SLICE:
        pred = owner_predicate
        if pred is None:
            src_lc = source.lower()
            def pred(row: dict[str, Any]) -> bool:
                return str(row.get(source_column, "")).strip().lower() == src_lc
        final, stats = _rebuild_owned_slice_impl(
            existing=existing,
            new_rows=rows,
            owner_predicate=pred,
            default_header=default_header,
        )
        _clear_and_write(svc, spreadsheet_id, tab, final)
        return stats

    if mode == OwnershipMode.APPEND_IF_MISSING:
        return _append_if_missing_impl(
            svc, spreadsheet_id, tab,
            existing=existing,
            new_rows=rows,
            default_header=default_header,
            key_column=key_column,
        )

    raise NotImplementedError(
        f"OwnershipMode.{mode.name} lands when a source needs it. "
        f"Currently implemented: REPLACE_SOURCE_ROWS, REBUILD_OWNED_SLICE, "
        f"APPEND_IF_MISSING"
    )
