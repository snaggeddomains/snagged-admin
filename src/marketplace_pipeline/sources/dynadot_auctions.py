"""Dynadot open auctions watchlist.

Port of legacy/openclaw/scripts/dynadot_open_fetch.py + dynadot_filter.py.
Fetches Dynadot's open-auctions API (paginated), filters through the
standard SNAP filter + a configurable horizon window, and publishes to
the auctions sheet + #auctions Slack section.

Requires DYNADOT_API_KEY + DYNADOT_API_SECRET secrets.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .. import auctions, config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "dynadot_auctions"
SOURCE_LABEL = "Dynadot"
PLATFORM = "Dynadot"

API_URL = "https://api.dynadot.com/api3.json"
AUCTION_TYPES = ("expired",)
HOURS_AHEAD = 24
PAGE_SIZE = 99  # Dynadot caps page_size around 99
MAX_PAGES = 10_000

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "dynadot_open.json"


def _fetch_page(
    session: requests.Session,
    *,
    api_key: str,
    api_secret: str,
    page_index: int,
    count_per_page: int,
    auction_types: list[str],
) -> dict[str, Any]:
    """Fetch one page from Dynadot. Raises on API or HTTP error."""
    params = {
        "key": api_key,
        "secret": api_secret,
        "command": "get_open_auctions",
        "currency": "usd",
        "type": ",".join(auction_types),
        "count_per_page": count_per_page,
        "page_index": page_index,
    }
    resp = session.get(API_URL, params=params, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    if data.get("status") != "success":
        raise RuntimeError(f"Dynadot API error on page {page_index}: {data}")
    return data


def _normalize_row(row: dict[str, Any]) -> dict[str, Any] | None:
    """Apply the standard SNAP filter and produce the AuctionListing-shaped dict."""
    domain = (row.get("utf_name") or row.get("domain") or "").strip().lower()
    if not domain or not flt.allow_domain(domain):
        return None
    end_ts = row.get("end_time_stamp")
    if not isinstance(end_ts, (int, float)):
        return None
    end_dt = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc)
    price_raw = row.get("current_bid_price") or row.get("price")
    try:
        price = float(price_raw) if price_raw not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    auction_id = row.get("auction_id")
    link = (
        f"https://www.dynadot.com/market/auction/{auction_id}.html"
        if auction_id else None
    )
    return {
        "domain": domain,
        "platform": PLATFORM,
        "end_time_utc": end_dt.isoformat(),
        "price": price,
        "bid_count": row.get("bids"),
        "link": link,
    }


def fetch_and_filter(
    *,
    api_key: str,
    api_secret: str,
    hours_ahead: int = HOURS_AHEAD,
    page_size: int = PAGE_SIZE,
    max_pages: int = MAX_PAGES,
    now: datetime | None = None,
    session: requests.Session | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch + filter Dynadot. Returns (listings, raw_payload).

    raw_payload is a dict suitable for caching to Drive (Tier 2).
    """
    sess = session or requests.Session()
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=hours_ahead)
    cutoff_ms = int(cutoff.timestamp() * 1000)

    all_normalized: list[dict[str, Any]] = []
    raw_filtered: list[dict[str, Any]] = []
    page_index = 1
    pages_fetched = 0
    total_seen = 0
    auction_types = list(AUCTION_TYPES)
    hit_max = False

    while page_index <= max_pages:
        data = _fetch_page(
            sess,
            api_key=api_key,
            api_secret=api_secret,
            page_index=page_index,
            count_per_page=page_size,
            auction_types=auction_types,
        )
        rows = data.get("auction_list") or []
        if not rows:
            break
        pages_fetched += 1
        total_seen += len(rows)

        min_end = None
        max_end = None
        kept_this_page = 0
        for row in rows:
            ts = row.get("end_time_stamp")
            if isinstance(ts, (int, float)):
                min_end = ts if min_end is None else min(min_end, ts)
                max_end = ts if max_end is None else max(max_end, ts)
                if ts <= cutoff_ms:
                    normalized = _normalize_row(row)
                    if normalized:
                        all_normalized.append(normalized)
                        raw_filtered.append(row)
                        kept_this_page += 1

        # Past the horizon? Stop.
        if min_end is not None and min_end > cutoff_ms:
            break
        # No qualifying rows on this page but max end is past cutoff - stop.
        if (
            kept_this_page == 0
            and max_end is not None and max_end > cutoff_ms
        ):
            break
        page_index += 1
    else:
        hit_max = True

    all_normalized.sort(key=lambda x: x["end_time_utc"])

    raw_payload = {
        "meta": {
            "generated_at": now.isoformat(),
            "cutoff_hours": hours_ahead,
            "pages_fetched": pages_fetched,
            "total_rows_seen": total_seen,
            "filtered_rows": len(raw_filtered),
            "types": auction_types,
            "hit_max_pages": hit_max,
        },
        "data": {"auction_detail_info_list": raw_filtered},
    }
    return all_normalized, raw_payload


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    api_key = os.environ.get("DYNADOT_API_KEY")
    api_secret = os.environ.get("DYNADOT_API_SECRET")
    if not api_key or not api_secret:
        raise RuntimeError(
            "DYNADOT_API_KEY and DYNADOT_API_SECRET must be set in the environment"
        )

    print(f"[1/6] Fetching Dynadot open auctions (horizon {HOURS_AHEAD}h)")
    listings, raw_payload = fetch_and_filter(api_key=api_key, api_secret=api_secret)
    print(
        f"      pages fetched: {raw_payload['meta']['pages_fetched']}  "
        f"raw rows seen: {raw_payload['meta']['total_rows_seen']:,}  "
        f"in-window qualifying: {len(listings):,}"
    )

    print("[2/6] Caching raw payload to Drive (Tier 2)")
    try:
        import json as _json
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_FILENAME,
            content=_json.dumps(raw_payload, indent=2).encode("utf-8"),
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]

    print("[3/6] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"      stats: {sheet_stats}")

    print("[4/6] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({
            **L,
            "time_left": auctions_sheet.format_time_left(end_dt, now=now),
        })

    if auctions.orchestrator_mode_active():
        print("[5/6] Slack post deferred to orchestrator")
        posted = False
    else:
        print(f"[5/6] Posting to Slack channel {slack_channel}")
        section = auctions_slack.format_section(label=SOURCE_LABEL, listings=slack_listings)
        posted = auctions_slack.post_consolidated(
            channel=slack_channel,
            source=SOURCE_ID,
            sections=[section],
            sheet_url=sheet_url,
        )
        print(f"      slack posted: {posted}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": sheet_stats["added"],
        "sheet_total_after": sheet_stats["total_after"],
        "deduped_against_existing": sheet_stats["deduped"],
        "slack_posted": posted,
    })

    print("[6/6] DONE")
    return 0
