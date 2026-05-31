"""Dynadot full-inventory daily dump (universe feeder).

Distinct from dynadot_auctions (the time-sensitive 24h auctions
watchlist published to Slack/Sheets). This source paginates the FULL
Dynadot open-auctions inventory with no time horizon, applies the
universe filter per-page, and stream-upserts qualifying domains into
Supabase name_universe.

Architecture notes (learned the hard way 2026-05-30):

  * Dynadot's get_open_auctions returns hundreds of thousands of
    expired-auction rows when there's no horizon filter — a previous
    run pulled 225K rows in 4.5 min before hitting their rate limit.
  * Rate limit error: 'Too many requests. Please try again in 1 minute
    after.' — caught specifically here and retried after sleeping 70s.
  * Naive 'accumulate everything in memory, upsert at end' loses all
    progress on a single error. We now stream-upsert in 5K-row chunks
    so partial runs persist what they got.
  * MAX_PAGES capped at 1500 (~148K rows) so daily runs stay tractable
    even when Dynadot's expired queue swells. Bump if needed.
  * 250 ms sleep between requests keeps us under ~240 req/min, well
    below the threshold that triggered the 429.

Reuses the API fetcher + auth from dynadot_auctions.py to stay
consistent on the v1 /api3.json endpoint (get_open_auctions, type=
expired, key+secret query auth).

Requires DYNADOT_API_KEY + DYNADOT_API_SECRET + SUPABASE_NAMING_*.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any, Callable

import requests

from .. import config, state
from ..filters import universe as univ
from ..universe import supabase_writer
from .dynadot_auctions import _fetch_page, AUCTION_TYPES, PAGE_SIZE

SOURCE_ID = "dynadot_dump"
SOURCE_LABEL = "Dynadot full dump"
SOURCE_TIER = 2

MAX_PAGES = 1500
FLUSH_SIZE = 5_000              # rows per Supabase upsert chunk
INTER_REQUEST_SLEEP = 0.25      # 250 ms politeness between API calls
RATE_LIMIT_BACKOFF_SECS = 70    # Dynadot says "try again in 1 minute"


def _row_to_universe_listing(row: dict[str, Any]) -> dict[str, Any] | None:
    """Pull domain + price out of a raw Dynadot row in the universe-snapshot
    shape ({domain, price}). Skips malformed rows. NO universe filter
    applied here — caller decides via passes_universe_filter()."""
    domain = (row.get("utf_name") or row.get("domain") or "").strip().lower()
    if not domain or "." not in domain:
        return None
    price_raw = row.get("current_bid_price") or row.get("price")
    try:
        price = float(price_raw) if price_raw not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    return {"domain": domain, "price": price}


def _stream_paginate(
    api_key: str,
    api_secret: str,
    on_chunk: Callable[[list[dict[str, Any]]], dict[str, Any]],
) -> dict[str, int]:
    """Paginate through get_open_auctions, applying the universe filter
    per-page and calling on_chunk(rows) every FLUSH_SIZE entries.

    Handles Dynadot's rate limit by sleeping RATE_LIMIT_BACKOFF_SECS
    and retrying the same page. Stops cleanly on empty response or
    MAX_PAGES. Returns counts for run_status.
    """
    sess = requests.Session()
    auction_types = list(AUCTION_TYPES)
    universe_buffer: list[dict[str, Any]] = []
    seen_domains: set[str] = set()

    raw_seen = 0
    universe_kept = 0
    upserted = 0
    batches = 0
    page_index = 1
    rate_limit_hits = 0

    while page_index <= MAX_PAGES:
        try:
            data = _fetch_page(
                sess,
                api_key=api_key,
                api_secret=api_secret,
                page_index=page_index,
                count_per_page=PAGE_SIZE,
                auction_types=auction_types,
            )
        except RuntimeError as e:
            if "Too many requests" in str(e):
                rate_limit_hits += 1
                print(
                    f"      page {page_index}: rate limited "
                    f"(hit #{rate_limit_hits}); sleeping {RATE_LIMIT_BACKOFF_SECS}s"
                )
                time.sleep(RATE_LIMIT_BACKOFF_SECS)
                continue  # retry same page
            raise

        rows = data.get("auction_list") or []
        if not rows:
            print(f"      page {page_index}: empty, stopping")
            break

        raw_seen += len(rows)
        for row in rows:
            listing = _row_to_universe_listing(row)
            if not listing:
                continue
            d = listing["domain"]
            if d in seen_domains:
                continue
            seen_domains.add(d)
            if univ.passes_universe_filter(d):
                universe_buffer.append(listing)
                universe_kept += 1

        if len(universe_buffer) >= FLUSH_SIZE:
            stats = on_chunk(universe_buffer)
            if stats.get("status") == "ok":
                upserted += stats.get("rows_sent", 0)
                batches += stats.get("batches", 0)
            universe_buffer = []

        if page_index % 50 == 0:
            print(
                f"      page {page_index}: raw {raw_seen:,}  "
                f"universe {universe_kept:,}  upserted {upserted:,}"
            )

        time.sleep(INTER_REQUEST_SLEEP)
        page_index += 1

    # Flush remainder
    if universe_buffer:
        stats = on_chunk(universe_buffer)
        if stats.get("status") == "ok":
            upserted += stats.get("rows_sent", 0)
            batches += stats.get("batches", 0)

    return {
        "raw_seen": raw_seen,
        "universe_kept": universe_kept,
        "upserted": upserted,
        "batches": batches,
        "pages_fetched": page_index - 1,
        "rate_limit_hits": rate_limit_hits,
    }


def run() -> int:
    config.get_source(SOURCE_ID)
    api_key = os.environ.get("DYNADOT_API_KEY")
    api_secret = os.environ.get("DYNADOT_API_SECRET")
    if not (api_key and api_secret):
        raise RuntimeError("DYNADOT_API_KEY and DYNADOT_API_SECRET must both be set")

    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/2] Streaming Dynadot open auctions through universe filter")

    def flush(batch: list[dict[str, Any]]) -> dict[str, Any]:
        return supabase_writer.upsert_from_source(
            SOURCE_ID, batch, today, source_tier=SOURCE_TIER,
        )

    counts = _stream_paginate(api_key, api_secret, flush)
    print(
        f"      done. raw rows: {counts['raw_seen']:,}  "
        f"universe kept: {counts['universe_kept']:,}  "
        f"upserted: {counts['upserted']:,}  "
        f"in {counts['batches']} batch(es) across "
        f"{counts['pages_fetched']:,} pages"
    )
    if counts["rate_limit_hits"]:
        print(f"      rate-limit retries: {counts['rate_limit_hits']}")

    print("[2/2] Saving run_status")
    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": counts["raw_seen"],
        "universe_count": counts["universe_kept"],
        "new_count": counts["upserted"],
        "pages_fetched": counts["pages_fetched"],
        "rate_limit_hits": counts["rate_limit_hits"],
        "supabase_status": "ok",
    })

    print("DONE")
    return 0
