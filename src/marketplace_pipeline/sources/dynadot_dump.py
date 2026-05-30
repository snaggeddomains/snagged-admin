"""Dynadot full-inventory daily dump (universe feeder).

Distinct from dynadot_auctions (the time-sensitive 24h auctions
watchlist published to Slack/Sheets). This source paginates the FULL
Dynadot open-auctions inventory with no time horizon, applies the
universe filter, and direct-upserts qualifying domains into Supabase
name_universe for the naming-exercise pool.

Architecture mirrors the legacy openclaw `dynadot_open_fetch.py` +
`dynadot_filter.py` + (missing) `dynadot_nameclub_diff.py` flow.
The diff step is implicit now — Supabase's upsert merge maintains
first_seen / last_seen / sources / best_price across days, so the
"net-new" / "dropped" / "price changed" facts fall out of the data
without a separate diff script.

Reuses the API fetcher + auth from dynadot_auctions.py to stay
consistent on the v1 /api3.json endpoint (get_open_auctions, type=
expired, key+secret query auth). The v2 RESTful aftermarket API is
still gated to our account, so v1 remains the working path.

Requires DYNADOT_API_KEY + DYNADOT_API_SECRET + the SUPABASE_NAMING_*
secrets.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..filters import universe as univ
from ..universe import supabase_writer
from .dynadot_auctions import _fetch_page, AUCTION_TYPES, PAGE_SIZE

SOURCE_ID = "dynadot_dump"
SOURCE_LABEL = "Dynadot full dump"

# No time-horizon. Cap pages high so we never silently truncate at scale.
# Dynadot's open-auctions inventory is in the tens of thousands of rows
# at any given time; at 99/page that's a few hundred pages.
MAX_PAGES = 5_000

UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "dynadot_dump.json"


def _row_to_universe_listing(row: dict[str, Any]) -> dict[str, Any] | None:
    """Pull domain + price out of a raw Dynadot row in the universe-snapshot
    shape ({domain, price}). Skips malformed rows. NO filter applied here —
    that happens in the caller via passes_universe_filter()."""
    domain = (row.get("utf_name") or row.get("domain") or "").strip().lower()
    if not domain or "." not in domain:
        return None
    price_raw = row.get("current_bid_price") or row.get("price")
    try:
        price = float(price_raw) if price_raw not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    return {"domain": domain, "price": price}


def fetch_all(*, api_key: str, api_secret: str) -> list[dict[str, Any]]:
    """Paginate through every page of get_open_auctions with no horizon cap.

    Stops when a page comes back empty (end of inventory) or MAX_PAGES is hit.
    """
    sess = requests.Session()
    listings: list[dict[str, Any]] = []
    auction_types = list(AUCTION_TYPES)
    page_index = 1
    while page_index <= MAX_PAGES:
        data = _fetch_page(
            sess,
            api_key=api_key,
            api_secret=api_secret,
            page_index=page_index,
            count_per_page=PAGE_SIZE,
            auction_types=auction_types,
        )
        rows = data.get("auction_list") or []
        if not rows:
            print(f"      page {page_index}: empty — stopping")
            break
        for row in rows:
            normalized = _row_to_universe_listing(row)
            if normalized:
                listings.append(normalized)
        if page_index % 25 == 0:
            print(f"      page {page_index}: collected {len(listings):,} so far")
        page_index += 1
    return listings


def run() -> int:
    config.get_source(SOURCE_ID)
    api_key = os.environ.get("DYNADOT_API_KEY")
    api_secret = os.environ.get("DYNADOT_API_SECRET")
    if not (api_key and api_secret):
        raise RuntimeError("DYNADOT_API_KEY and DYNADOT_API_SECRET must both be set")

    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/4] Paginating Dynadot open auctions (no horizon)")
    all_listings = fetch_all(api_key=api_key, api_secret=api_secret)
    print(f"      collected {len(all_listings):,} raw rows")

    print("[2/4] Applying universe filter")
    universe_entries = [L for L in all_listings if univ.passes_universe_filter(L["domain"])]
    print(f"      universe entries: {len(universe_entries):,}")
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)

    print("[3/4] Upserting universe entries to Supabase name_universe")
    uni_stats = supabase_writer.upsert_from_source(SOURCE_ID, universe_entries, today)
    if uni_stats["status"] == "ok":
        print(f"      upserted {uni_stats['rows_sent']:,} rows in {uni_stats['batches']} batch(es)")
    else:
        print(f"      skipped: {uni_stats.get('reason')}")

    print("[4/4] Saving raw snapshot for diff tracking")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, all_listings)

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(all_listings),
        "universe_count": len(universe_entries),
        "new_count": uni_stats.get("rows_sent", 0),
        "supabase_status": uni_stats.get("status"),
    })

    print("DONE")
    return 0
