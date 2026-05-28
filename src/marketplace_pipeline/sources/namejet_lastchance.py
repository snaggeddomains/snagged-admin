"""NameJet last-chance auctions (direct Playwright scrape).

Port of legacy/openclaw/scripts/namejet_lastchance_scraper.py, replacing
the legacy Cloudflare Browser Rendering API path with a direct Playwright
fetch from GitHub Actions runners. NameJet sits behind Cloudflare bot
management; if the request gets challenged, we detect the
'Just a moment...' / challenges.cloudflare.com markers in the response
and fail with a clear error, instead of silently writing a junk snapshot.

If direct scraping is blocked, the user has two options:
  (a) Wire CF_BROWSER_ACCOUNT_ID + CF_BROWSER_API_TOKEN as secrets and we
      add a fallback path that proxies through Cloudflare Browser Rendering.
  (b) Continue using drive_auction_uploads as the NameJet ingestion path
      (currently doing the same job via manual exports).
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

SOURCE_ID = "namejet_lastchance"
SOURCE_LABEL = "NameJet Last Chance"
PLATFORM = "NameJet"

BASE_TARGET = (
    "https://www.namejet.com/store/exclusivestorefront.action"
    "?searchType=contains"
    "&orderbydate=1"
    "&tld=.com,.org,.net,.io,.ai,.co"
    "&sourceType=%2C1,%2C"
    "&listingType=1,2"
    "&bidorbuyinclude=1"
)
DEFAULT_ROWS_PER_PAGE = 250
MAX_PAGES = 6  # safety cap; 250 * 6 = 1500 listings, well over last-chance set
HOURS_AHEAD = 24  # last-chance means closing within 24h

# Statuses the legacy filter accepted (from domain_filters.ALLOWED_STATUSES)
ALLOWED_STATUSES = {"In Auction", "Pre-Release", "Available Soon"}

# Cloudflare challenge markers (legacy parity)
CF_CHALLENGE_MARKERS = ("Just a moment...", "challenges.cloudflare.com")

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME_TEMPLATE = "namejet_lastchance_page{page}.html"

NY_TZ = ZoneInfo("America/New_York")


class CloudflareChallengeError(RuntimeError):
    """Raised when NameJet returns a Cloudflare bot-challenge page."""


# ---------- pure helpers ----------

def build_page_url(start_index: int, end_index: int, rows: int) -> str:
    return f"{BASE_TARGET}&startIndex={start_index}&endIndex={end_index}&rowsPerPage={rows}"


def is_cloudflare_challenge(html: str) -> bool:
    """Detect Cloudflare's bot-challenge page so we fail loudly, not silently."""
    return all(marker in html for marker in CF_CHALLENGE_MARKERS)


def parse_money(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = text.replace("$", "").replace(",", "").strip()
    try:
        return float(cleaned)
    except (TypeError, ValueError):
        return None


def parse_int_str(text: str | None) -> int | None:
    if not text:
        return None
    try:
        return int(text.strip())
    except (TypeError, ValueError):
        return None


def parse_countdown(text: str, *, now_utc: datetime) -> datetime | None:
    """Convert NameJet countdown text like '5h 30m' into a UTC datetime."""
    if not text:
        return None
    text = " ".join(text.split())
    if not text:
        return None
    lower = text.lower()
    normalized = (
        lower.replace("hours", "h").replace("hour", "h").replace("hrs", "h")
             .replace("mins", "m").replace("min", "m")
    )
    if "h" in normalized or "m" in normalized:
        hours = 0.0
        minutes = 0.0
        hm = re.search(r"(\d+(?:\.\d+)?)\s*h", normalized)
        mm = re.search(r"(\d+(?:\.\d+)?)\s*m", normalized)
        if hm:
            try:
                hours = float(hm.group(1))
            except ValueError:
                pass
        if mm:
            try:
                minutes = float(mm.group(1))
            except ValueError:
                pass
        return now_utc + timedelta(hours=hours, minutes=minutes)
    return None


def parse_rows(html: str, *, now: datetime | None = None) -> list[dict[str, Any]]:
    """Extract auction rows from a NameJet exclusive-storefront page."""
    from bs4 import BeautifulSoup

    if is_cloudflare_challenge(html):
        raise CloudflareChallengeError(
            "NameJet returned a Cloudflare challenge page — direct scraping "
            "is blocked. Options: (a) add CF_BROWSER_ACCOUNT_ID + "
            "CF_BROWSER_API_TOKEN secrets and we'll add the CF Browser "
            "Rendering fallback, or (b) keep drive_auction_uploads as the "
            "NameJet ingestion path."
        )

    soup = BeautifulSoup(html, "lxml")
    now = now or datetime.now(timezone.utc)
    out: list[dict[str, Any]] = []
    for tr in soup.select("#searchTable tbody tr"):
        a = tr.find("a")
        if not a:
            continue
        domain = a.get_text(strip=True).lower()
        if not flt.allow_domain(domain):
            continue
        status_cell = tr.find("td", class_="status")
        status = status_cell.get_text(strip=True) if status_cell else ""
        if status not in ALLOWED_STATUSES:
            continue
        closing_cell = tr.find("td", class_="dtOrderBy")
        closing_text = closing_cell.get_text(" ", strip=True) if closing_cell else ""
        closing_dt = parse_countdown(closing_text, now_utc=now)
        if closing_dt is None:
            continue
        hours_to_close = (closing_dt - now).total_seconds() / 3600
        if hours_to_close < 0 or hours_to_close > HOURS_AHEAD:
            continue
        min_bid_el = tr.find("span", class_="resultsMinimumBid")
        bidders_el = tr.find("div", class_="biddersCount")
        out.append({
            "domain": domain,
            "platform": PLATFORM,
            "end_time_utc": closing_dt.isoformat(),
            "price": parse_money(min_bid_el.get_text(strip=True) if min_bid_el else None),
            "bid_count": parse_int_str(bidders_el.get_text(strip=True) if bidders_el else None),
            "link": f"https://www.namejet.com/domain/{domain}.action",
            "status": status,
        })
    out.sort(key=lambda x: x["end_time_utc"])
    return out


# ---------- Playwright fetch ----------

def fetch_html(url: str, *, timeout_ms: int = 60_000) -> str:
    """Render one NameJet page via headless Chromium."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            # Try to wait for the search table; if Cloudflare challenge, this
            # will timeout and we'll handle below.
            try:
                page.wait_for_selector("#searchTable tbody tr", timeout=20_000)
            except Exception:
                pass
            page.wait_for_timeout(3000)
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

    all_rows: list[dict[str, Any]] = []
    seen_domains: set[str] = set()
    rows_per_page = DEFAULT_ROWS_PER_PAGE

    for page_idx in range(MAX_PAGES):
        start_index = page_idx * rows_per_page + 1
        end_index = (page_idx + 1) * rows_per_page
        url = build_page_url(start_index, end_index, rows_per_page)
        print(f"[fetch] page {page_idx + 1}: rows {start_index}-{end_index}")
        html = fetch_html(url)
        print(f"        received {len(html):,} chars")

        try:
            drive_cache.cache_raw(
                source=SOURCE_ID, report_date=today,
                filename=RAW_FILENAME_TEMPLATE.format(page=page_idx + 1),
                content=html.encode("utf-8"),
            )
        except Exception as e:
            print(f"        WARN raw cache write failed (non-fatal): {e}")

        page_rows = parse_rows(html)
        # Dedupe across pages (results overlap sometimes)
        new_on_page = [r for r in page_rows if r["domain"] not in seen_domains]
        for r in new_on_page:
            seen_domains.add(r["domain"])
        all_rows.extend(new_on_page)
        print(f"        page rows: {len(page_rows):,}  new this page: {len(new_on_page):,}  total: {len(all_rows):,}")

        # Stop early if this page produced no new rows
        if not new_on_page:
            print(f"        no new rows; stopping pagination")
            break

    print(f"[parse] Total qualifying last-chance auctions: {len(all_rows):,}")
    all_rows.sort(key=lambda r: r["end_time_utc"])

    now = datetime.now(timezone.utc)
    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in all_rows]

    print("[write] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
    )
    print(f"        stats: {sheet_stats}")

    print("[state] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, all_rows)

    slack_listings = []
    for L in all_rows:
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
