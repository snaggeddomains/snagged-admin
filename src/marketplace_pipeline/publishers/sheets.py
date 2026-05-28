"""Shared Google Sheets publisher with explicit row-ownership semantics.

Every source declares how it owns rows in a shared destination tab. The four
supported modes derive from observed behavior in the legacy OpenClaw scripts.
See docs/domain-dumps-and-platform-workflows-spec.md section 9.1.

Implementation lands with the first source port.
"""
from __future__ import annotations

from enum import Enum
from typing import Any


class OwnershipMode(str, Enum):
    """How a source updates rows in a shared sheet tab."""

    REPLACE_SOURCE_ROWS = "replace_source_rows"
    """Delete this source's existing rows for the current report_date, then insert
    new rows. Other sources' rows untouched.
    Example: Namecheap BIN daily refresh of 'Today's New Listings'."""

    PREPEND_NEW_ROWS = "prepend_new_rows"
    """Insert new rows at the top under the header. Existing rows pushed down.
    Example: Atom Wholesale daily doc ingest into 'Running' tab."""

    APPEND_IF_MISSING = "append_if_missing"
    """Append rows only for domains not already present in the sheet.
    Example: Atom net-new rows into 'Running Good Deals'."""

    REBUILD_OWNED_SLICE = "rebuild_owned_slice"
    """Drop all of this source's rows, replace with the current full shortlist;
    do NOT touch rows from other sources.
    Example: Afternic rebuild of 'Running Good Deals'."""


def write_rows(
    *,
    spreadsheet_id: str,
    tab: str,
    mode: OwnershipMode,
    source: str,
    rows: list[dict[str, Any]],
    source_column: str = "source",
) -> None:
    """Write rows to a sheet tab according to the declared ownership mode.

    Args:
        spreadsheet_id: Google Sheet ID.
        tab: Tab name.
        mode: One of the four ownership modes above.
        source: Source label (used to identify "owned" rows in modes that
            preserve foreign rows).
        rows: List of dicts; each dict's keys map to sheet column headers.
        source_column: Header name of the column that records the source label.
    """
    raise NotImplementedError("Sheets publisher stub — lands with first source port")
