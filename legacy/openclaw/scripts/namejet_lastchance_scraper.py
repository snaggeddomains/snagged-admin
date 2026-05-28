#!/usr/bin/env python3
"""Pull the NameJet "Last Chance" inventory via Cloudflare Browser Rendering.

Requirements
------------
- Set the following environment variables before running:
    CF_BROWSER_ACCOUNT_ID  -> Cloudflare account id (bea1ad7b1ffbb9241c0887abde660a54)
    CF_BROWSER_API_TOKEN   -> API token with Browser Rendering – Edit
- A virtualenv with requests + beautifulsoup4 installed (`.venv` already has both)

Example usage
-------------
$ CF_BROWSER_ACCOUNT_ID=... CF_BROWSER_API_TOKEN=... \
  .venv/bin/python scripts/namejet_lastchance_scraper.py \
      --page-size 250 --output data/namejet_lastchance_full.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Iterable

import requests
from bs4 import BeautifulSoup
from zoneinfo import ZoneInfo

WORKSPACE = Path(__file__).resolve().parents[1]
if str(WORKSPACE / "scripts") not in sys.path:
    sys.path.insert(0, str((WORKSPACE / "scripts")))

from domain_filters import ALLOWED_STATUSES, allow_domain  # type: ignore  # noqa: E402

CF_ACCOUNT_ID = os.environ.get("CF_BROWSER_ACCOUNT_ID")
CF_API_TOKEN = os.environ.get("CF_BROWSER_API_TOKEN")
SECRETS_PATH = WORKSPACE / ".secrets/cloudflare_browser_rendering.json"
if (not CF_ACCOUNT_ID or not CF_API_TOKEN) and SECRETS_PATH.exists():
    try:
        data = json.loads(SECRETS_PATH.read_text())
        CF_ACCOUNT_ID = CF_ACCOUNT_ID or data.get("account_id")
        CF_API_TOKEN = CF_API_TOKEN or data.get("api_token")
    except json.JSONDecodeError:
        pass
if not CF_ACCOUNT_ID or not CF_API_TOKEN:
    raise SystemExit(
        "CF_BROWSER_ACCOUNT_ID/CF_BROWSER_API_TOKEN env vars not set and cloudflare_browser_rendering.json is missing"
    )

BROWSER_ENDPOINT = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}/browser-rendering/content"
BASE_TARGET = (
    "https://www.namejet.com/store/exclusivestorefront.action"
    "?searchType=contains"
    "&orderbydate=1"
    "&tld=.com,.org,.net,.io,.ai,.co"
    "&sourceType=%2C1,%2C"
    "&listingType=1,2"
    "&bidorbuyinclude=1"
)
TOTAL_COUNT_RE = re.compile(r"of\s+([\d,]+)\s+domain", re.I)
NY_TZ = ZoneInfo("America/New_York")
UTC = dt.timezone.utc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape NameJet Last Chance auctions via Cloudflare Browser Rendering")
    parser.add_argument("--page-size", type=int, default=250, help="rows per request (<=250 recommended)")
    parser.add_argument("--max-pages", type=int, default=None, help="optional safety limit for number of pages")
    parser.add_argument("--output", type=Path, default=WORKSPACE / "data/namejet_lastchance_full.json",
                        help="where to write the filtered JSON output")
    return parser.parse_args()


def build_target_url(start_index: int, end_index: int, rows: int) -> str:
    return f"{BASE_TARGET}&startIndex={start_index}&endIndex={end_index}&rowsPerPage={rows}"


def fetch_page_html(target_url: str, timeout: int = 90) -> str:
    body = {
        "url": target_url,
        "waitForSelector": {"selector": "#searchTable tbody tr", "timeout": 45000},
        "gotoOptions": {"waitUntil": "domcontentloaded"},
        "waitForTimeout": 5000,
        "bestAttempt": True,
    }
    headers = {
        "Authorization": f"Bearer {CF_API_TOKEN}",
        "Content-Type": "application/json",
    }
    resp = requests.post(BROWSER_ENDPOINT, headers=headers, json=body, timeout=timeout)
    if resp.status_code >= 400:
        detail = resp.text[:1000]
        raise RuntimeError(f"Cloudflare Browser Rendering HTTP {resp.status_code}: {detail}")
    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(f"Cloudflare Browser Rendering returned error: {payload.get('errors')}")
    html = payload["result"]
    if "Just a moment..." in html and "challenges.cloudflare.com" in html:
        debug_path = WORKSPACE / "data/namejet_lastchance_challenge.html"
        debug_path.write_text(html)
        raise RuntimeError(f"NameJet returned a Cloudflare challenge page; saved debug HTML to {debug_path}")
    return html


def extract_total_count(soup: BeautifulSoup) -> int | None:
    counter = soup.select_one("#domainCount")
    if not counter:
        return None
    match = TOTAL_COUNT_RE.search(counter.get_text(" ", strip=True))
    if not match:
        return None
    return int(match.group(1).replace(",", ""))


def parse_rows(soup: BeautifulSoup, now_utc: dt.datetime) -> list[dict]:
    results: list[dict] = []
    rows = soup.select("#searchTable tbody tr")
    for row in rows:
        link = row.find("a")
        if not link:
            continue
        domain = link.get_text(strip=True)
        status_cell = row.find("td", class_="status")
        status = status_cell.get_text(strip=True) if status_cell else ""
        if status not in ALLOWED_STATUSES:
            continue
        if not allow_domain(domain):
            continue
        closing_cell = row.find("td", class_="dtOrderBy")
        closing_text = closing_cell.get_text(" ", strip=True) if closing_cell else ""
        closing_dt = parse_countdown(closing_text, now_utc)
        if closing_dt is None:
            continue
        hours_to_close = (closing_dt - now_utc).total_seconds() / 3600
        if hours_to_close < 0 or hours_to_close > 24:
            continue
        min_bid = parse_money(row.find("span", class_="resultsMinimumBid"))
        bidders = parse_int(row.find("div", class_="biddersCount"))
        age_years = parse_int(row.find("td", class_="domainage"))
        results.append({
            "domain": domain,
            "status": status,
            "closing_dt_utc": closing_dt.isoformat(),
            "closing_text": closing_text,
            "hours_to_close": round(hours_to_close, 2),
            "min_bid": min_bid,
            "bidders": bidders,
            "age_years": age_years,
        })
    return results


def parse_money(node) -> float | None:
    if not node:
        return None
    text = node.get_text(strip=True).replace("$", "").replace(",", "")
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def parse_int(node) -> int | None:
    if not node:
        return None
    text = node.get_text(strip=True)
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def parse_countdown(text: str, now_utc: dt.datetime) -> dt.datetime | None:
    text = " ".join(text.split())
    if not text:
        return None
    lower = text.lower()
    normalized = lower.replace("hours", "h").replace("hour", "h").replace("hrs", "h").replace("mins", "m").replace("min", "m")
    if "h" in normalized or "m" in normalized:
        hours = 0.0
        minutes = 0.0
        hour_match = re.search(r"(\d+(?:\.\d+)?)\s*h", normalized)
        minute_match = re.search(r"(\d+(?:\.\d+)?)\s*m", normalized)
        if hour_match:
            try:
                hours = float(hour_match.group(1))
            except ValueError:
                hours = 0.0
        if minute_match:
            try:
                minutes = float(minute_match.group(1))
            except ValueError:
                minutes = 0.0
        return now_utc + dt.timedelta(hours=hours, minutes=minutes)
    try:
        closing_local = dt.datetime.strptime(text, "%b %d, %Y %I:%M %p").replace(tzinfo=NY_TZ)
        return closing_local.astimezone(UTC)
    except ValueError:
        return None


def dedupe(results: Iterable[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for row in results:
        seen[row["domain"].lower()] = row
    return list(seen.values())


def main() -> None:
    args = parse_args()
    page_size = max(25, min(250, args.page_size))
    output_path: Path = args.output
    all_rows: list[dict] = []
    total_count = None
    start = 1
    page = 0

    while True:
        if args.max_pages is not None and page >= args.max_pages:
            break
        tentative_end = start + page_size - 1
        if total_count is not None:
            end = min(tentative_end, total_count)
        else:
            end = tentative_end
        target_url = build_target_url(start, end, page_size)
        print(f"Requesting rows {start}-{end} (page {page + 1})", flush=True)
        html = fetch_page_html(target_url)
        soup = BeautifulSoup(html, "lxml")
        if total_count is None:
            total_count = extract_total_count(soup)
            if total_count is None:
                raise RuntimeError("Could not extract total domain count from NameJet HTML")
            end = min(end, total_count)
        page += 1
        print(f"Fetched rows {start}-{end} (page {page})")
        page_now = dt.datetime.now(UTC)
        page_rows = parse_rows(soup, page_now)
        all_rows.extend(page_rows)
        if end >= total_count:
            break
        start = end + 1
        # jitter to avoid hammering the endpoint
        time.sleep(1.2 + random.random())

    output_path.parent.mkdir(parents=True, exist_ok=True)
    data = dedupe(all_rows)
    data.sort(key=lambda row: row["closing_dt_utc"])
    output_path.write_text(json.dumps(data, indent=2))
    print(f"Wrote {len(data)} filtered rows to {output_path}")


if __name__ == "__main__":
    main()
