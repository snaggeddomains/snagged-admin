"""Snagged-owned SNAP inventory (Google Sheet).

Reads the 'SNAP' tab from the team's primary inventory sheet, filters to
currently-owned rows, and upserts as tier-1 inventory into Supabase
name_universe.

One of three tier-1 sources documented in the playbook (§3.4). Tier-1
means "owned / controlled inventory" — queried FIRST in every naming
exercise, only widening to tier-2 if the first pass is weak.

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var; sheet must be shared with
the service-account email (Viewer).
"""
from __future__ import annotations

from ._sheet_tier1_helpers import process_sheet_tier1

SOURCE_ID = "snagged_snap_sheet"
SOURCE_LABEL = "Snagged SNAP (sheet)"

SPREADSHEET_ID = "1KaxYUgBFALe_T0F8-6D0kb7mWy-eU5CkIbX6BGmyK4g"
TAB_NAME = "SNAP Domains"
DOMAIN_COL = "Domain"
PRICE_COL = "Internal Price"
ACTIVE_COL = "Still Owned?"


def run() -> int:
    return process_sheet_tier1(
        source_id=SOURCE_ID,
        source_label=SOURCE_LABEL,
        spreadsheet_id=SPREADSHEET_ID,
        tab_name=TAB_NAME,
        domain_col=DOMAIN_COL,
        price_col=PRICE_COL,
        active_col=ACTIVE_COL,
    )
