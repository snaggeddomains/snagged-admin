"""NameSilo expired-auctions watchlist.

Port of legacy/openclaw/scripts/namesilo_auctions_fetch.py. Hits NameSilo's
listAuctions API for active expired auctions, with the legacy's
fast-forward optimization: pages are returned in end-time-ascending order,
old already-ended pages dominate the start, so we jump ahead in chunks
until we land in-window, then iterate linearly.

Requires NAMESILO_API_KEY secret.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .. import auctions, config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "namesilo_auctions"
SOURCE_LABEL = "NameSilo"
PLATFORM = "NameSilo"

API_URL = "https://www.namesilo.com/public/api/listAuctions"
HOURS_AHEAD = 48
PAGE_SIZE = 500
DEFAULT_MAX_PAGES = 150
DEFAULT_JUMP_PAGES = 25
MAX_SEARCH_PAGE = 5000

STATUS_ACTIVE = 2     # statusId for "active"
TYPE_EXPIRED = 3      # typeId for expired auction

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "namesilo_auctions.json"


def _parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        # NameSilo sometimes uses a space separator instead of 'T'
        try:
            dt = datetime.fromisoformat(text.replace(" ", "T"))
        except (ValueError, TypeError):
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _fetch_page(
    session: requests.Session, *, api_key: str, page: int,
) -> list[dict[str, Any]]:
    """Fetch one page of NameSilo auctions; retries on 429."""
    params = {
        "version": 1,
        "type": "json",
        "key": api_key,
        "statusId": STATUS_ACTIVE,
        "typeId": TYPE_EXPIRED,
        "page": page,
        "pageSize": PAGE_SIZE,
        "orderBy": "auctionEndsOn",
        "orderType": "ASC",
    }
    for attempt in range(5):
        resp = session.get(API_URL, params=params, timeout=60)
        if resp.status_code == 429 and attempt < 4:
            time.sleep(1.5 * (attempt + 1))
            continue
        resp.raise_for_status()
        data = resp.json()
        return (data.get("reply") or {}).get("body") or []
    return []


def _row_end_time(row: dict[str, Any]) -> datetime | None:
    return _parse_time(row.get("auctionEndsOnUtc") or row.get("auctionEndsOn"))


def _normalize_row(row: dict[str, Any], *, now: datetime, cutoff: datetime) -> dict[str, Any] | None:
    domain = (row.get("domainName") or row.get("domain") or "").strip().lower()
    if not domain or not flt.allow_domain(domain):
        return None
    end_time = _row_end_time(row)
    if not end_time or not (now <= end_time <= cutoff):
        return None
    price_raw = row.get("currentBid") or row.get("openingBid")
    try:
        price = float(price_raw) if price_raw not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    bids = row.get("bidsQuantity")
    try:
        bid_count = int(bids) if bids not in (None, "") else None
    except (TypeError, ValueError):
        bid_count = None
    return {
        "domain": domain,
        "platform": PLATFORM,
        "end_time_utc": end_time.isoformat(),
        "price": price,
        "bid_count": bid_count,
        "link": (row.get("url") or "").strip() or None,
    }


def _determine_start_page(
    session: requests.Session, *, api_key: str, now: datetime, jump: int,
) -> int:
    """Jump forward in `jump`-page strides until we land in-window."""
    page = 1
    jump = max(1, jump)
    while page <= MAX_SEARCH_PAGE:
        rows = _fetch_page(session, api_key=api_key, page=page)
        if not rows:
            return 1
        last_end = _row_end_time(rows[-1])
        if last_end and last_end >= now:
            return max(1, page - jump)
        page += jump
        time.sleep(0.2)
    return 1


def fetch_and_filter(
    *,
    api_key: str,
    hours_ahead: int = HOURS_AHEAD,
    max_pages: int = DEFAULT_MAX_PAGES,
    jump_pages: int = DEFAULT_JUMP_PAGES,
    now: datetime | None = None,
    session: requests.Session | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Fetch + filter NameSilo. Returns (listings, raw_payload)."""
    sess = session or requests.Session()
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=hours_ahead)

    start_page = _determine_start_page(sess, api_key=api_key, now=now, jump=jump_pages)
    page = start_page
    processed = 0
    matches: list[dict[str, Any]] = []
    raw_kept: list[dict[str, Any]] = []

    while processed < max_pages and page <= MAX_SEARCH_PAGE:
        rows = _fetch_page(sess, api_key=api_key, page=page)
        if not rows:
            break
        last_end = _row_end_time(rows[-1])
        if last_end and last_end < now:
            # Whole page is already-ended; jump ahead by one.
            page += 1
            continue
        first_end = _row_end_time(rows[0])
        if first_end and first_end > cutoff:
            # Past the horizon — nothing more useful ahead.
            break
        for row in rows:
            normalized = _normalize_row(row, now=now, cutoff=cutoff)
            if normalized:
                matches.append(normalized)
                raw_kept.append(row)
        processed += 1
        page += 1
        time.sleep(0.3)

    matches.sort(key=lambda x: x["end_time_utc"])
    raw_payload = {
        "generated_at": now.isoformat(),
        "start_page": start_page,
        "pages_processed": processed,
        "match_count": len(matches),
        "matches": raw_kept,
    }
    return matches, raw_payload


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    api_key = os.environ.get("NAMESILO_API_KEY")
    if not api_key:
        raise RuntimeError("NAMESILO_API_KEY must be set in the environment")

    print(f"[1/6] Fetching NameSilo expired auctions (horizon {HOURS_AHEAD}h)")
    listings, raw_payload = fetch_and_filter(api_key=api_key)
    print(
        f"      start page: {raw_payload['start_page']}  "
        f"pages processed: {raw_payload['pages_processed']}  "
        f"qualifying: {len(listings):,}"
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
