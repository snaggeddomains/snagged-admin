"""Sedo expired auctions watchlist.

Port of legacy/openclaw/scripts/sedo_expired_fetch.py. Fetches Sedo's public
expired-auction CSV export, filters through the standard SNAP domain filter,
and publishes to the auctions sheet + #auctions Slack section.

No credentials — the CSV is served from a public URL. A standard User-Agent
is sent to avoid bot-block.
"""
from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "sedo_expired_auctions"
SOURCE_LABEL = "Sedo Expired"
PLATFORM = "Sedo Expired"

FETCH_URL = "https://expiringdomains.sedo.com/api/search/export"
USER_AGENT = "Mozilla/5.0 SnaggedSweep/1.0"

# Sedo dataset is broad; default TLD set matches legacy parity. The standard
# filter further restricts within these.
ALLOWED_TLDS = ("com", "org", "io")
SLD_LENGTH_MIN = 1
SLD_LENGTH_MAX = 12

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "sedo_expired.csv"


def _parse_float(value: str | None) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _parse_int(value: str | None) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return None


def _parse_end_time(raw: str | None) -> datetime | None:
    """Parse Sedo's 'Auction End Date'. Tries ISO 8601 first; returns None
    on unrecognized formats so the caller can skip the row."""
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    # ISO 8601 with Z or offset
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        pass
    # Try common date formats. Sedo's export has been observed in a few
    # variants; extend as we encounter more.
    for fmt in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
        "%Y/%m/%d %H:%M:%S",
        "%d.%m.%Y %H:%M:%S",
        "%d.%m.%Y",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            return dt.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            continue
    return None


def parse_csv_rows(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def parse_auctions(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        domain = (row.get("Domain Ace") or row.get("Domain Idn") or "").strip().lower()
        if not domain or "." not in domain:
            continue
        sld, tld = flt.extract_sld_tld(domain)
        if tld.lstrip(".") not in ALLOWED_TLDS:
            continue
        if not (SLD_LENGTH_MIN <= len(sld) <= SLD_LENGTH_MAX):
            continue
        if not flt.allow_domain(domain):
            continue
        end_dt = _parse_end_time(row.get("Auction End Date"))
        if not end_dt:
            continue
        price = _parse_float(row.get("Current Bid"))
        bid_count = _parse_int(row.get("Bids Count"))
        currency = (row.get("Currency") or "EUR").strip() or "EUR"
        out.append({
            "domain": domain,
            "platform": PLATFORM,
            "end_time_utc": end_dt.isoformat(),
            "price": price,
            "currency": currency,
            "bid_count": bid_count,
            "link": f"https://sedo.com/search/details/?domain={domain}",
        })
    out.sort(key=lambda x: (x["end_time_utc"], -(x.get("price") or 0)))
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
    resp = requests.get(FETCH_URL, headers={"User-Agent": USER_AGENT}, timeout=120)
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

    print("[4/7] Filtering")
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
