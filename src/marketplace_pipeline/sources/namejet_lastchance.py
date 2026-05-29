"""NameJet last-chance auctions (Playwright -> Cloudflare Browser Rendering fallback).

Port of legacy/openclaw/scripts/namejet_lastchance_scraper.py. NameJet sits
behind Cloudflare bot management, so we try two paths in order:

  1. Direct Playwright fetch from the GH Actions runner (free, fast when
     it works).
  2. If the response contains Cloudflare's challenge markers
     ('Just a moment...' + 'challenges.cloudflare.com') AND
     CF_BROWSER_ACCOUNT_ID + CF_BROWSER_API_TOKEN are set, fall back to
     the Cloudflare Browser Rendering API which proxies through their
     own infrastructure (Cloudflare can't block itself).

If both fail, raise CloudflareChallengeError with a clear next-step
message instead of silently writing a junk snapshot.
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

def fetch_html_via_playwright(url: str, *, timeout_ms: int = 60_000) -> str:
    """Render one NameJet page via headless Chromium (direct, free path)."""
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page()
            page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
            try:
                page.wait_for_selector("#searchTable tbody tr", timeout=20_000)
            except Exception:
                # Probably challenged; let parse_rows surface the markers.
                pass
            page.wait_for_timeout(3000)
            html = page.content()
        finally:
            browser.close()
    return html


def _cf_post(account_id: str, api_token: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """Single POST to CF Browser Rendering /content endpoint. Returns
    (status_code, decoded_json)."""
    import requests as _r

    endpoint = (
        f"https://api.cloudflare.com/client/v4/accounts/{account_id}"
        f"/browser-rendering/content"
    )
    resp = _r.post(
        endpoint,
        headers={
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=150,
    )
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"success": False, "errors": [{"message": resp.text[:500]}]}


def fetch_html_via_cf_browser_rendering(url: str) -> str:
    """Proxy the request through Cloudflare's Browser Rendering API.

    Tries two configs in sequence:
      1. Strict — waits for the search table selector specifically.
      2. Lenient — drops the selector wait, just lets the page settle.
         NameJet sometimes takes longer than the strict timeout to fully
         hydrate, but the page body is usually usable before that.

    Requires CF_BROWSER_ACCOUNT_ID + CF_BROWSER_API_TOKEN.
    Endpoint: api.cloudflare.com/client/v4/accounts/<id>/browser-rendering/content
    """
    account_id = os.environ.get("CF_BROWSER_ACCOUNT_ID")
    api_token = os.environ.get("CF_BROWSER_API_TOKEN")
    if not (account_id and api_token):
        raise CloudflareChallengeError(
            "Direct Playwright was challenged AND CF_BROWSER_ACCOUNT_ID / "
            "CF_BROWSER_API_TOKEN are not set. Add the Cloudflare Browser "
            "Rendering secrets to fall back automatically."
        )

    attempts = [
        {
            "label": "strict (waits for #searchTable)",
            "body": {
                "url": url,
                "gotoOptions": {"waitUntil": "domcontentloaded"},
                "waitForSelector": {"selector": "#searchTable tbody tr", "timeout": 30000},
                "waitForTimeout": 5000,
                "bestAttempt": True,
            },
        },
        {
            "label": "lenient (no selector wait, longer settle)",
            "body": {
                "url": url,
                "gotoOptions": {"waitUntil": "domcontentloaded"},
                "waitForTimeout": 15000,
                "bestAttempt": True,
            },
        },
    ]

    last_err: str | None = None
    for attempt in attempts:
        print(f"        CF attempt: {attempt['label']}")
        status, payload = _cf_post(account_id, api_token, attempt["body"])
        if status >= 400:
            errors_text = (
                str(payload.get("errors") or payload)[:400]
                if isinstance(payload, dict) else str(payload)[:400]
            )
            last_err = f"HTTP {status}: {errors_text}"
            print(f"        CF returned {last_err}")
            continue
        if not payload.get("success"):
            last_err = f"success=false: {payload.get('errors')}"
            print(f"        CF returned {last_err}")
            continue
        html = payload.get("result") or ""
        if not html:
            last_err = "empty HTML"
            continue
        return html

    raise RuntimeError(
        f"Cloudflare Browser Rendering exhausted attempts. Last error: {last_err}"
    )


def fetch_html_via_scrape_do(url: str) -> str:
    """Fetch via scrape.do. Uses render=true (JS) + super=true (residential
    super proxies) since NameJet is JS-heavy + CF-protected. waitSelector
    holds the response until #searchTable tbody tr is in the DOM so we
    don't get the pre-hydration shell back. Requires SCRAPE_DO_TOKEN."""
    import requests as _r

    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN not set")
    params = {
        "token": token,
        "url": url,
        "render": "true",
        "super": "true",
        "geoCode": "us",
        "waitUntil": "networkidle0",
        "waitSelector": "#searchTable tbody tr",
        "customWait": "5000",
    }
    resp = _r.get("https://api.scrape.do/", params=params, timeout=180)
    resp.raise_for_status()
    return resp.text


def fetch_html(url: str, *, timeout_ms: int = 60_000) -> str:
    """Tiered fetch:

      1. scrape.do (if SCRAPE_DO_TOKEN set) — purpose-built for CF bypass.
         Tried first when available; no Playwright cost when this works.
      2. Direct Playwright from the GH Actions runner — fastest if NameJet
         hasn't tightened its rules.
      3. Cloudflare Browser Rendering — proxies through CF's own browser
         (if CF_BROWSER_ACCOUNT_ID + CF_BROWSER_API_TOKEN are set).

    Returns the first non-challenge HTML response. Raises
    CloudflareChallengeError if every available path was challenged.
    """
    if os.environ.get("SCRAPE_DO_TOKEN"):
        print("        attempting via scrape.do (super proxies)")
        try:
            html = fetch_html_via_scrape_do(url)
            if not is_cloudflare_challenge(html):
                return html
            print("        scrape.do returned a challenge page; falling back")
        except Exception as e:
            print(f"        scrape.do attempt failed: {e}; falling back")

    html = fetch_html_via_playwright(url, timeout_ms=timeout_ms)
    if is_cloudflare_challenge(html):
        print("        WARN direct Playwright got Cloudflare challenge; "
              "falling back to CF Browser Rendering")
        html = fetch_html_via_cf_browser_rendering(url)
        if is_cloudflare_challenge(html):
            raise CloudflareChallengeError(
                "Cloudflare Browser Rendering also returned a challenge page. "
                "Token may need broader scope or the endpoint may be down."
            )
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
        if not page_rows and page_idx == 0:
            # Sanity check: did the fetched HTML actually contain the table
            # markup at all? If not, the renderer returned before hydration.
            table_present = "id=\"searchTable\"" in html or "id='searchTable'" in html
            row_count_hint = html.count("<tr")
            print(
                f"        WARN page 1 parsed to 0 rows. "
                f"searchTable in HTML: {table_present}, raw <tr count: {row_count_hint}. "
                f"If the table is absent, the renderer returned pre-hydration; "
                f"if it's present, the row schema may have changed."
            )
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
