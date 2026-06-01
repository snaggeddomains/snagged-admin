"""Berserk SNAP tracker (Google Sheet).

Reads the Berserk SNAP tracker tab (Rob + Brian joint purchases) and upserts
it as tier-1 (owned/controlled) inventory into Supabase name_universe.

The tab is targeted by its stable URL gid rather than its title, so renaming
the tab won't break ingest. The domain lives in the 'Asset Name' column and the
price in 'Purchase Price'; every row is ingested (no "still owned" filter).

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var; the sheet must be shared with the
service-account email (Viewer).
"""
from __future__ import annotations

from ._sheet_tier1_helpers import process_sheet_tier1

SOURCE_ID = "berserk_snap_sheet"
SOURCE_LABEL = "Berserk SNAP tracker (sheet)"

SPREADSHEET_ID = "1oHfG8FYlTTclnB-gi0IkkhbqnXXYfeewOBiZn9Hds4M"
TAB_GID = 257551532
DOMAIN_COL = "Asset Name"
PRICE_COL = "Purchase Price"
ACTIVE_COL = None  # no "still owned" column — ingest every row


def run() -> int:
    return process_sheet_tier1(
        source_id=SOURCE_ID,
        source_label=SOURCE_LABEL,
        spreadsheet_id=SPREADSHEET_ID,
        gid=TAB_GID,
        domain_col=DOMAIN_COL,
        price_col=PRICE_COL,
        active_col=ACTIVE_COL,
    )
