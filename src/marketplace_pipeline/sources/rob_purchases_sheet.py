"""Rob-owned domain inventory (Google Sheet).

Reads the 'Rob Purchases' tab from the team's primary inventory sheet,
filters to currently-owned rows, and upserts as tier-1 inventory into
Supabase name_universe.

Per the playbook (§3.4, §4.1), Rob-owned inventory is one of the
required tier-1 source pools queried first in every naming exercise.

Uses 'Atom Current Price' as the price signal (Rob's domains are often
priced for sale via Atom).

Requires GOOGLE_SERVICE_ACCOUNT_JSON env var; sheet must be shared with
the service-account email (Viewer).
"""
from __future__ import annotations

from ._sheet_tier1_helpers import process_sheet_tier1

SOURCE_ID = "rob_purchases_sheet"
SOURCE_LABEL = "Rob Purchases (sheet)"

SPREADSHEET_ID = "1KaxYUgBFALe_T0F8-6D0kb7mWy-eU5CkIbX6BGmyK4g"
TAB_NAME = "Rob Purchases"
DOMAIN_COL = "Domain"
PRICE_COL = "Atom Current Price"
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
