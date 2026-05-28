"""DropCatch auctions watchlist (browser-scraped).

Port of legacy/openclaw/scripts/dropcatch_auctions_fetch.py. DropCatch has
no public API, so we render the live page via Playwright + Chromium, then
parse the resulting HTML with BeautifulSoup. Workflow needs to install
the chromium bundle (`playwright install chromium --with-deps`) before
the source runs.

No API credentials needed — but the workflow is heavier than the JSON-API
producers due to the browser dependency (~3-5 min extra per run).
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from .. import auctions, config, drive_cache, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
from ..filters import standard as flt

SOURCE_ID = "dropcatch_auctions"
SOURCE_LABEL = "DropCatch"
PLATFORM = "DropCatch"

LISTING_URL = "https://www.dropcatch.com/auctions"
HOURS_AHEAD = 7 * 24
EASTERN = ZoneInfo("America/New_York")

TIME_PATTERN = re.compile(
    r"(?:(?P<days>\d+)d)?\s*(?:(?P<hours>\d+)h)?\s*(?:(?P<minutes>\d+)m)?",
    re.IGNORECASE,
)

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "dropcatch_listing.html"


# ---------- pure helpers ----------

def parse_time_left(text: str) -> timedelta | None:
    """Parse a string like '2d 3h 12m' into a timedelta."""
    if not text:
        return None
    m = TIME_PATTERN.search(text.strip())
    if not m:
        return None
    days = int(m.group("days") or 0)
    hours = int(m.group("hours") or 0)
    minutes = int(m.group("minutes") or 0)
    if days == hours == minutes == 0:
        return None
    return timedelta(days=days, hours=hours, minutes=minutes)


def parse_auctions(html: str, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Scrape auction cards out of the DropCatch listing page HTML."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "lxml")
    now = (now or datetime.now(EASTERN)).astimezone(EASTERN)
    cutoff = now + timedelta(hours=HOURS_AHEAD)
    out: list[dict[str, Any]] = []
    for card in soup.select("section.dc-table__list-item"):
        domain_link = card.select_one("a.domain-item")
        if not domain_link:
            continue
        domain = domain_link.get_text(strip=True).lower()
        if not flt.allow_domain(domain):
            continue
        time_el = card.select_one("time#time-remaining")
        time_text = time_el.get_text(strip=True) if time_el else ""
        delta = parse_time_left(time_text)
        if not delta:
            continue
        end_dt = now + delta
        if end_dt > cutoff:
            continue

        price_value: float | None = None
        price_el = card.select_one("span#domainPrice")
        if price_el:
            cleaned = price_el.get_text(strip=True).replace("$", "").replace(",", "").strip()
            try:
                price_value = float(cleaned)
            except ValueError:
                price_value = None

        bids_value: int | None = None
        bids_el = card.select_one("span#bidCount")
        if bids_el:
            try:
                bids_value = int(bids_el.get_text(strip=True))
            except ValueError:
                bids_value = None

        url = domain_link.get("href") or ""
        if url and url.startswith("/"):
            url = f"https://www.dropcatch.com{url}"

        out.append({
            "domain": domain,
            "platform": PLATFORM,
            "end_time_utc": end_dt.astimezone(timezone.utc).isoformat(),
            "price": price_value,
            "bid_count": bids_value,
            "link": url or None,
        })
    out.sort(key=lambda x: x["end_time_utc"])
    return out


# ---------- Playwright fetch ----------

def fetch_html() -> str:
    """Launch a headless Chromium, navigate to the listing page, return HTML."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(LISTING_URL, wait_until="networkidle")
            page.wait_for_timeout(5000)
            html = page.content()
        finally:
            browser.close()
    return html


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/7] Rendering {LISTING_URL} via headless Chromium")
    html = fetch_html()
    print(f"      received {len(html):,} chars of HTML")

    print("[2/7] Caching raw HTML to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_FILENAME, content=html.encode("utf-8"),
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print(f"[3/7] Parsing cards + filtering (next {HOURS_AHEAD}h)")
    listings = parse_auctions(html)
    print(f"      qualifying auctions: {len(listings):,}")

    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]

    print("[4/7] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"      stats: {sheet_stats}")

    print("[5/7] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({
            **L,
            "time_left": auctions_sheet.format_time_left(end_dt, now=now),
        })

    if auctions.orchestrator_mode_active():
        print("[6/7] Slack post deferred to orchestrator")
        posted = False
    else:
        print(f"[6/7] Posting to Slack channel {slack_channel}")
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
