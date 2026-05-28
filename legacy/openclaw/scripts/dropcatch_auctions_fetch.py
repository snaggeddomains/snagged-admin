#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from bs4 import BeautifulSoup
from playwright.async_api import async_playwright
from zoneinfo import ZoneInfo

from domain_filters import allow_domain

HOURS_AHEAD = 7 * 24
HOURS_AHEAD = 7 * 24
OUTPUT_JSON = Path('dropcatch_auctions_latest.json')
LISTING_URL = 'https://www.dropcatch.com/auctions'
EASTERN = ZoneInfo('America/New_York')
TIME_PATTERN = re.compile(r"(?:(?P<days>\d+)d)?\s*(?:(?P<hours>\d+)h)?\s*(?:(?P<minutes>\d+)m)?", re.IGNORECASE)


def parse_time_left(text: str) -> timedelta | None:
    match = TIME_PATTERN.search(text.strip())
    if not match:
        return None
    days = int(match.group('days') or 0)
    hours = int(match.group('hours') or 0)
    minutes = int(match.group('minutes') or 0)
    if days == hours == minutes == 0:
        return None
    return timedelta(days=days, hours=hours, minutes=minutes)


def is_missing_playwright_browser(exc: BaseException) -> bool:
    text = str(exc)
    return 'Executable doesn\'t exist at' in text and 'playwright install' in text


def install_playwright_chromium() -> None:
    subprocess.run([sys.executable, '-m', 'playwright', 'install', 'chromium'], check=True)


async def fetch_html() -> str:
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page()
        await page.goto(LISTING_URL, wait_until='networkidle')
        await page.wait_for_timeout(5000)
        html = await page.content()
        await browser.close()
    return html


def fetch_html_with_repair() -> str:
    try:
        return asyncio.run(fetch_html())
    except Exception as exc:
        if not is_missing_playwright_browser(exc):
            raise
        print('Playwright Chromium bundle missing, reinstalling...', flush=True)
        install_playwright_chromium()
        return asyncio.run(fetch_html())


def parse_auctions(html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, 'lxml')
    rows = []
    now = datetime.now(EASTERN)
    cutoff = now + timedelta(hours=HOURS_AHEAD)
    for card in soup.select('section.dc-table__list-item'):
        domain_link = card.select_one('a.domain-item')
        if not domain_link:
            continue
        domain = domain_link.get_text(strip=True)
        if not allow_domain(domain):
            continue
        time_el = card.select_one('time#time-remaining')
        time_text = time_el.get_text(strip=True) if time_el else ''
        delta = parse_time_left(time_text)
        if not delta:
            continue
        end_dt = now + delta
        if end_dt > cutoff:
            continue
        price_el = card.select_one('span#domainPrice')
        price_text = price_el.get_text(strip=True) if price_el else ''
        price_value = None
        if price_text:
            cleaned = price_text.replace('$', '').replace(',', '').strip()
            try:
                price_value = float(cleaned)
            except ValueError:
                price_value = None
        bids_el = card.select_one('span#bidCount')
        bids_text = bids_el.get_text(strip=True) if bids_el else ''
        try:
            bids_value = int(bids_text)
        except ValueError:
            bids_value = None
        url = domain_link.get('href')
        if url and url.startswith('/'):
            url = f"https://www.dropcatch.com{url}"
        rows.append({
            'domain': domain.lower(),
            'price': price_value,
            'bids': bids_value,
            'endDate': end_dt.astimezone(timezone.utc).isoformat(),
            'sourceUrl': url,
        })
    rows.sort(key=lambda item: item['endDate'])
    return rows


def main() -> None:
    html = fetch_html_with_repair()
    auctions = parse_auctions(html)
    OUTPUT_JSON.write_text(json.dumps({
        'fetchedAt': datetime.now(timezone.utc).isoformat(),
        'count': len(auctions),
        'auctions': auctions,
    }, indent=2))
    print(f"Captured {len(auctions)} DropCatch auctions ending within the next {HOURS_AHEAD} hours.")


if __name__ == '__main__':
    main()
