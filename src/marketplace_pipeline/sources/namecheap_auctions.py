"""Namecheap auctions watchlist.

Port of legacy/openclaw/scripts/namecheap_auctions_crawl.py. Fetches the
public Namecheap marketplace auction CSV, filters auctions ending in the
next 120 hours through the standard SNAP domain filter, and publishes
rows to the auctions sheet plus a Slack section.

This is a different feed from namecheap_bin (which is the Buy Now CSV);
this one is `Namecheap_Market_Sales.csv` — the auction feed.
"""
from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .. import auctions, config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "namecheap_auctions"
SOURCE_LABEL = "Namecheap"
PLATFORM = "Namecheap"

FETCH_URL = "https://d3ry1h4w5036x1.cloudfront.net/reports/Namecheap_Market_Sales.csv"
HOURS_AHEAD = 120

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "Namecheap_Market_Sales.csv"


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None


def parse_csv_rows(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8-sig", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def parse_auctions(rows: list[dict[str, str]], *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Filter Namecheap auction rows through the standard SNAP filter + horizon."""
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=HOURS_AHEAD)
    out: list[dict[str, Any]] = []
    for sale in rows:
        domain = (sale.get("name") or "").strip().lower()
        if not domain or not flt.allow_domain(domain):
            continue
        end_dt = _parse_dt(sale.get("endDate"))
        if not end_dt:
            continue
        if end_dt.tzinfo is None:
            end_dt = end_dt.replace(tzinfo=timezone.utc)
        if end_dt < now or end_dt > cutoff:
            continue
        price_raw = sale.get("price") or sale.get("startPrice") or "0"
        try:
            price = float(price_raw)
        except (TypeError, ValueError):
            price = 0.0
        bid_count_raw = sale.get("bidCount") or "0"
        try:
            bid_count = int(float(bid_count_raw))
        except (TypeError, ValueError):
            bid_count = 0
        out.append({
            "domain": domain,
            "platform": PLATFORM,
            "end_time_utc": end_dt.astimezone(timezone.utc).isoformat(),
            "price": price if price > 0 else None,
            "bid_count": bid_count,
            "link": (sale.get("url") or "").strip() or None,
        })
    out.sort(key=lambda x: (x["end_time_utc"], -(x.get("bid_count") or 0)))
    return out


def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/7] Downloading {FETCH_URL}")
    resp = requests.get(FETCH_URL, timeout=120)
    resp.raise_for_status()
    raw = resp.content
    print(f"      fetched {len(raw):,} bytes")

    print("[2/7] Caching raw to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_FILENAME, content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/7] Parsing CSV")
    rows = parse_csv_rows(raw)
    print(f"      raw rows: {len(rows):,}")

    print(f"[4/7] Filtering (auctions ending in next {HOURS_AHEAD}h)")
    listings = parse_auctions(rows)
    print(f"      qualifying auctions: {len(listings):,}")

    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]

    print("[5/7] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"      stats: {sheet_stats}")

    print("[6/7] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({
            **L,
            "time_left": auctions_sheet.format_time_left(end_dt, now=now),
        })

    if auctions.orchestrator_mode_active():
        print("[7/7] Slack post deferred to orchestrator")
        posted = False
    else:
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
