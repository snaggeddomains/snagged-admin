"""Park.io auction watchlist.

Port of legacy/openclaw/scripts/parkio_auctions_fetch.py adapted to the new
architecture. Fetches auctions ending in the next 7 days, filters them
through the standard daily-SNAP filter, and publishes:
  - Rows to the auctions sheet (5-col, prepend mode, dedup by domain+end)
  - A Slack section to #auctions

When more auction producers come online, this source will be wrapped by
the auctions_publish orchestrator and stop posting Slack directly — the
orchestrator will collect all producers' listings and post one
consolidated message.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .. import config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "parkio_auctions"
SOURCE_LABEL = "Park.io"
PLATFORM = "Park.io"

FETCH_URL = "https://park.io/auctions.json?limit=500"
HOURS_AHEAD = 7 * 24

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "auctions.json"


def _parse_close_date(raw: str | None) -> datetime | None:
    """Park.io's close_date format: 'YYYY/DD/MM HH:MM:SS' in Eastern Time.

    Note the unusual day/month ordering — matches legacy parse logic.
    """
    if not raw or len(raw) < 21:
        return None
    try:
        from zoneinfo import ZoneInfo
        eastern = ZoneInfo("America/New_York")
        year = int(raw[0:4])
        day = int(raw[5:7])
        month = int(raw[8:10])
        hour = int(raw[13:15])
        minute = int(raw[16:18])
        second = int(raw[19:21])
        dt = datetime(year, month, day, hour, minute, second, tzinfo=eastern)
        return dt.astimezone(timezone.utc)
    except (ValueError, ImportError):
        return None


def parse_auctions(payload: dict[str, Any], *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Filter Park.io payload through the standard SNAP filter + horizon window."""
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=HOURS_AHEAD)
    raw_auctions = payload.get("auctions") or []
    out: list[dict[str, Any]] = []
    for a in raw_auctions:
        name = a.get("name")
        if not name or not flt.allow_domain(name):
            continue
        close_dt = _parse_close_date(a.get("close_date"))
        if not close_dt or close_dt < now or close_dt > cutoff:
            continue
        try:
            price = float(a.get("price")) if a.get("price") is not None else None
        except (TypeError, ValueError):
            price = None
        out.append({
            "domain": name.lower(),
            "platform": PLATFORM,
            "end_time_utc": close_dt.isoformat(),
            "price": price,
            "bid_count": (
                int(a.get("num_bids"))
                if isinstance(a.get("num_bids"), (int, str)) and str(a.get("num_bids")).strip().isdigit()
                else None
            ),
            "link": None,
        })
    out.sort(key=lambda x: x["end_time_utc"])
    return out


def run() -> int:
    reg = config.load_registry()
    src_cfg = config.get_source(SOURCE_ID)  # noqa: F841 (validates the source exists)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/7] Downloading {FETCH_URL}")
    resp = requests.get(FETCH_URL, timeout=60)
    resp.raise_for_status()
    raw = resp.content
    print(f"      fetched {len(raw):,} bytes")

    print("[2/7] Caching raw to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID,
            report_date=today,
            filename=RAW_FILENAME,
            content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/7] Parsing + filtering")
    payload = resp.json()
    listings = parse_auctions(payload)
    print(f"      qualifying auctions (next {HOURS_AHEAD}h): {len(listings):,}")

    print("[4/7] Building sheet rows")
    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]

    print(f"[5/7] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"      stats: {sheet_stats}")

    print("[6/7] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    # Build listings with time_left for slack
    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({
            **L,
            "time_left": auctions_sheet.format_time_left(end_dt, now=now),
        })

    print(f"[7/7] Posting to Slack channel {slack_channel}")
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

    print("DONE")
    return 0
