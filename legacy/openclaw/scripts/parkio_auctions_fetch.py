#!/usr/bin/env python3
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from zoneinfo import ZoneInfo

from domain_filters import allow_domain

HOURS_AHEAD = 7 * 24  # pull the next 7 days of Park.io auctions
HOURS_AHEAD = 7 * 24  # pull the next 7 days of Park.io auctions
OUTPUT_JSON = Path('parkio_auctions_latest.json')
API_URL = 'https://park.io/auctions.json'
EASTERN = ZoneInfo('America/New_York')


def parse_close_date(raw: str | None) -> datetime | None:
    if not raw or len(raw) < 21:
        return None
    try:
        year = int(raw[0:4])
        day = int(raw[5:7])
        month = int(raw[8:10])
        hour = int(raw[13:15])
        minute = int(raw[16:18])
        second = int(raw[19:21])
        dt = datetime(year, month, day, hour, minute, second, tzinfo=EASTERN)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def fetch_auctions() -> list[dict[str, Any]]:
    resp = requests.get(f'{API_URL}?limit=500', timeout=30)
    resp.raise_for_status()
    payload = resp.json()
    auctions = payload.get('auctions') or []
    return auctions


def main() -> None:
    auctions = fetch_auctions()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=HOURS_AHEAD)
    filtered: list[dict[str, Any]] = []
    for auction in auctions:
        name = auction.get('name')
        if not name or not allow_domain(name):
            continue
        close_dt = parse_close_date(auction.get('close_date'))
        if not close_dt or close_dt < now or close_dt > cutoff:
            continue
        price_raw = auction.get('price')
        try:
            price_val = float(price_raw)
        except (TypeError, ValueError):
            price_val = None
        bids_raw = auction.get('num_bids')
        try:
            bids_val = int(bids_raw)
        except (TypeError, ValueError):
            bids_val = None
        filtered.append({
            'id': auction.get('id'),
            'domain': name.lower(),
            'price': price_val,
            'bids': bids_val,
            'endDate': close_dt.isoformat(),
        })

    filtered.sort(key=lambda item: item['endDate'])
    OUTPUT_JSON.write_text(json.dumps({
        'fetchedAt': datetime.now(timezone.utc).isoformat(),
        'count': len(filtered),
        'auctions': filtered,
    }, indent=2))
    print(f"Captured {len(filtered)} Park.io auctions ending within the next {HOURS_AHEAD} hours.")


if __name__ == '__main__':
    main()
