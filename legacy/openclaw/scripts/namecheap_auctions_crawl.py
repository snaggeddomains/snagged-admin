#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

from domain_filters import ALLOWED_TLDS, min_zipf_for_tld, passes_word_filter

CSV_URL = 'https://d3ry1h4w5036x1.cloudfront.net/reports/Namecheap_Market_Sales.csv'
OUTPUT_JSON = Path('namecheap_auctions_latest.json')
ALLOWED_TLDS_FLAT = {t.lstrip('.') for t in ALLOWED_TLDS}
HOURS = 120


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except Exception:
        return None


def load_rows() -> list[dict]:
    resp = requests.get(CSV_URL, timeout=120)
    resp.raise_for_status()
    text = resp.content.decode('utf-8-sig', errors='replace')
    reader = csv.DictReader(io.StringIO(text))
    return list(reader)


def main() -> None:
    rows = load_rows()
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=HOURS)
    matches: list[dict] = []

    for sale in rows:
        name = (sale.get('name') or '').strip().lower()
        if not name:
            continue
        parts = name.split('.')
        if len(parts) != 2:
            continue
        sld, tld = parts
        if tld not in ALLOWED_TLDS_FLAT:
            continue
        if not passes_word_filter(sld, min_zipf_for_tld(tld)):
            continue
        end_dt = parse_dt(sale.get('endDate'))
        if not end_dt or end_dt < now or end_dt > cutoff:
            continue
        price_raw = sale.get('price') or sale.get('startPrice') or '0'
        bid_count_raw = sale.get('bidCount') or '0'
        try:
            price = float(price_raw)
        except Exception:
            price = 0.0
        try:
            bid_count = int(float(bid_count_raw))
        except Exception:
            bid_count = 0
        matches.append({
            'domain': name,
            'price': price,
            'bidCount': bid_count,
            'endDate': end_dt.isoformat(),
            'estibot': sale.get('estibotValue'),
            'godaddyValue': sale.get('goValue'),
            'extensionsTaken': sale.get('extensionsTaken'),
            'url': sale.get('url'),
            'keywordSearchCount': sale.get('keywordSearchCount'),
            'registeredDate': sale.get('registeredDate'),
        })

    matches.sort(key=lambda x: (x['endDate'], -int(x.get('bidCount') or 0), -(float(x.get('price') or 0))))

    payload = {
        'fetchedAt': datetime.now(timezone.utc).isoformat(),
        'source': CSV_URL,
        'totalRows': len(rows),
        'matches': matches,
    }
    OUTPUT_JSON.write_text(json.dumps(payload, indent=2))

    print(f'Downloaded {len(rows):,} Namecheap marketplace rows from CSV')
    print(f'Matches found: {len(matches):,}')
    for item in matches[:25]:
        print(f"{item['domain']:25} | ${item['price']:,.2f} | bids {item['bidCount']:2} | ends {item['endDate']}")


if __name__ == '__main__':
    main()
