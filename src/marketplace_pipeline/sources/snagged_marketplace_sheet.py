"""Snagged Marketplace inventory (Google Sheet — 'Snagged Names Under
Representation' workbook, 'Complete List' tab).

Domains brokered by Snagged on behalf of various owners. Distinct from
the SNAP sheet (which is Snagged's own holdings); this one is the
public marketplace catalog. Per the playbook (§3.4, §4.1) this is a
required tier-1 source pool — queried first in every naming exercise.

Uses 'BIN' (Buy-It-Now) as the price column.

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var; sheet must be shared with
the service-account email (Viewer).
"""
from __future__ import annotations

from ._sheet_tier1_helpers import process_sheet_tier1

SOURCE_ID = "snagged_marketplace_sheet"
SOURCE_LABEL = "Snagged Marketplace (sheet)"

SPREADSHEET_ID = "1hL_F0e3-qV_7XsF_ZIrvXlygwkKogvrMud4o1NgnXw4"
TAB_NAME = "Complete List"
DOMAIN_COL = "Domain"
PRICE_COL = "BIN"
ACTIVE_COL = "Active"


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
