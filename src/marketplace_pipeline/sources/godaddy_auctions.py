"""GoDaddy auctions watchlist.

Port of legacy/openclaw/scripts/godaddy_auctions_fetch.py. GoDaddy publishes
two public zip files for upcoming auctions (today + tomorrow). We fetch
both, extract the embedded JSON, filter through the standard SNAP filter
within a 48h horizon, and publish to the auctions sheet + #auctions Slack.

No credentials needed — the dumps are anonymously downloadable.
"""
from __future__ import annotations

import io
import json
import os
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from .. import auctions, config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "godaddy_auctions"
SOURCE_LABEL = "GoDaddy"
PLATFORM = "GoDaddy"

BASE_URL = "https://inventory.auctions.godaddy.com/"
DUMP_NAMES = ("auctions_ending_today.json.zip", "auctions_ending_tomorrow.json.zip")
HORIZON_HOURS = 48

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def _parse_price(text: str | int | float | None) -> float | None:
    if text in (None, ""):
        return None
    if isinstance(text, (int, float)):
        return float(text)
    clean = str(text).replace("$", "").replace(",", "").strip()
    if not clean:
        return None
    try:
        return float(clean)
    except ValueError:
        return None


def extract_rows_from_zip(zip_bytes: bytes) -> list[dict[str, Any]]:
    """Return every row from `data` in every .json member of the zip."""
    rows: list[dict[str, Any]] = []
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for member in zf.namelist():
            if not member.lower().endswith(".json"):
                continue
            with zf.open(member) as fh:
                payload = json.load(fh)
            data = payload.get("data") or []
            if isinstance(data, list):
                rows.extend(data)
    return rows


def parse_auctions(
    rows: list[dict[str, Any]],
    *,
    now: datetime | None = None,
    horizon_hours: int = HORIZON_HOURS,
) -> list[dict[str, Any]]:
    now = now or datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=horizon_hours)
    out: list[dict[str, Any]] = []
    seen_domains: set[str] = set()
    for row in rows:
        if row.get("isAdult"):
            continue
        domain = (row.get("domainName") or "").strip().lower()
        if not domain or not flt.allow_domain(domain):
            continue
        # Today + tomorrow zips may overlap; dedupe within this run.
        if domain in seen_domains:
            continue
        end_dt = _parse_time(row.get("auctionEndTime"))
        if not end_dt or not (now <= end_dt <= cutoff):
            continue
        seen_domains.add(domain)
        out.append({
            "domain": domain,
            "platform": PLATFORM,
            "end_time_utc": end_dt.isoformat(),
            "price": _parse_price(row.get("price")),
            "bid_count": row.get("numberOfBids"),
            "link": (row.get("link") or "").strip() or None,
        })
    out.sort(key=lambda x: x["end_time_utc"])
    return out


def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    all_rows: list[dict[str, Any]] = []
    for i, name in enumerate(DUMP_NAMES, start=1):
        url = f"{BASE_URL}{name}"
        print(f"[{i}/{len(DUMP_NAMES)}] Downloading {url}")
        resp = requests.get(url, timeout=180)
        resp.raise_for_status()
        zip_bytes = resp.content
        print(f"        fetched {len(zip_bytes):,} bytes")

        try:
            drive_cache.cache_raw(
                source=SOURCE_ID, report_date=today,
                filename=name, content=zip_bytes,
            )
        except Exception as e:
            print(f"        WARN raw cache write failed (non-fatal): {e}")

        rows = extract_rows_from_zip(zip_bytes)
        print(f"        extracted {len(rows):,} rows from {name}")
        all_rows.extend(rows)

    print(f"[parse] Combined rows: {len(all_rows):,}")
    listings = parse_auctions(all_rows)
    print(f"[parse] Qualifying auctions (next {HORIZON_HOURS}h): {len(listings):,}")

    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]

    print("[write] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"        stats: {sheet_stats}")

    print("[state] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({
            **L,
            "time_left": auctions_sheet.format_time_left(end_dt, now=now),
        })

    if auctions.orchestrator_mode_active():
        print("[slack] Slack post deferred to orchestrator")
        posted = False
    else:
        print(f"[slack] Posting to channel {slack_channel}")
        section = auctions_slack.format_section(label=SOURCE_LABEL, listings=slack_listings)
        posted = auctions_slack.post_consolidated(
            channel=slack_channel,
            source=SOURCE_ID,
            sections=[section],
            sheet_url=sheet_url,
        )
        print(f"        slack posted: {posted}")

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
