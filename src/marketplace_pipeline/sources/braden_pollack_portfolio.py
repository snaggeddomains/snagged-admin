"""Braden Pollack portfolio (external, public-CSV).

Braden's domain holdings, mirrored into a public Google Sheet via
IMPORTRANGE from his private master at 1Y9M5zopsJQ4YCyBoaOOcL1huCWHsgOoU1rdon.
The sheet is shared 'Anyone with the link → Viewer' (he can't add our
service-account email), so we fetch the public CSV export URL.

This is an OWNERSHIP REGISTRY, not a marketplace listing:
  - Most rows have Sub Category = 'Not For Sale' (in-house use)
  - A few are 'Loan'
  - No price column at all

For the naming-exercise pool, that means every Braden row lands with
best_price = NULL. The downstream naming UI should treat these as
"known to be owned by Braden, may be acquirable through negotiation"
rather than as priced-for-sale listings.

Tier-2 source (external inventory, not Snagged-owned).
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .. import config, google_sheets_reader as gsr, state
from ..filters import universe as univ
from ..universe import supabase_writer

SOURCE_ID = "braden_pollack_portfolio"
SOURCE_LABEL = "Braden Pollack Portfolio"
SOURCE_TIER = 2

SPREADSHEET_ID = "18IG0Siuih3uJdqbhzbOhiubVsS-f4ob51qyJkN4FCac"
GID = 0
DOMAIN_COL = "Domain"


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/3] Reading public CSV from sheet {SPREADSHEET_ID} (gid={GID})")
    rows = gsr.read_public_csv_as_dicts(SPREADSHEET_ID, gid=GID)
    print(f"      raw rows: {len(rows):,}")

    print("[2/3] Filtering: domain present + universe filter")
    universe_entries: list[dict[str, Any]] = []
    skipped_bad_domain = 0
    skipped_filter = 0
    for row in rows:
        domain = (row.get(DOMAIN_COL) or "").strip().lower()
        if not domain or "." not in domain:
            skipped_bad_domain += 1
            continue
        if not univ.passes_universe_filter(domain):
            skipped_filter += 1
            continue
        universe_entries.append({"domain": domain, "price": None})
    print(
        f"      drops — bad_domain: {skipped_bad_domain} "
        f"universe_filter: {skipped_filter}"
    )
    print(f"      universe entries: {len(universe_entries):,}")

    print(f"[3/3] Upserting to Supabase name_universe (tier={SOURCE_TIER})")
    stats = supabase_writer.upsert_from_source(
        SOURCE_ID, universe_entries, today, source_tier=SOURCE_TIER,
    )
    if stats["status"] == "ok":
        print(f"      upserted {stats['rows_sent']:,} rows in {stats['batches']} batch(es)")
    else:
        print(f"      skipped: {stats.get('reason')}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(rows),
        "universe_count": len(universe_entries),
        "new_count": stats.get("rows_sent", 0),
        "supabase_status": stats.get("status"),
    })

    print("DONE")
    return 0
