#!/usr/bin/env python3
"""Fetch Sedo expired auction domains and emit a filtered JSON snapshot."""

from __future__ import annotations

import argparse
import csv
import io
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

from domain_filters import allow_domain, extract_sld

EXPORT_URL = 'https://expiringdomains.sedo.com/api/search/export'
DEFAULT_TLDS = ('com', 'org', 'io')
DEFAULT_LENGTH_MIN = 1
DEFAULT_LENGTH_MAX = 12
DEFAULT_OUTPUT = Path('data/sedo_expired_auctions.json')


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tlds', default=','.join(DEFAULT_TLDS), help='Comma-separated TLDs to keep')
    p.add_argument('--length-min', type=int, default=DEFAULT_LENGTH_MIN)
    p.add_argument('--length-max', type=int, default=DEFAULT_LENGTH_MAX)
    p.add_argument('--out', type=Path, default=DEFAULT_OUTPUT)
    return p.parse_args()


def parse_float(value: str | None) -> float | None:
    if value in (None, ''):
        return None
    try:
        return float(str(value).replace(',', '').strip())
    except ValueError:
        return None


def parse_int(value: str | None) -> int | None:
    if value in (None, ''):
        return None
    try:
        return int(float(str(value).replace(',', '').strip()))
    except ValueError:
        return None


def main() -> None:
    args = parse_args()
    allowed_tlds = {t.strip().lower().lstrip('.') for t in args.tlds.split(',') if t.strip()}

    session = requests.Session()
    resp = session.get(EXPORT_URL, headers={'User-Agent': 'Mozilla/5.0 SnaggedSweep/1.0'}, timeout=120)
    resp.raise_for_status()

    reader = csv.DictReader(io.StringIO(resp.text))
    matches = []
    scanned = 0
    for row in reader:
        scanned += 1
        domain = (row.get('Domain Ace') or row.get('Domain Idn') or '').strip().lower()
        if not domain or '.' not in domain:
            continue
        sld, tld = extract_sld(domain)
        if tld.lstrip('.') not in allowed_tlds:
            continue
        if not (args.length_min <= len(sld) <= args.length_max):
            continue
        if not allow_domain(domain):
            continue
        price = parse_float(row.get('Current Bid'))
        bids = parse_int(row.get('Bids Count'))
        end_time = (row.get('Auction End Date') or '').strip()
        matches.append({
            'domain': domain,
            'price': price,
            'currency': (row.get('Currency') or 'EUR').strip() or 'EUR',
            'bidCount': bids,
            'endTime': end_time,
            'link': f'https://sedo.com/search/details/?domain={domain}',
            'source': 'Sedo Expired',
        })

    def sort_key(item: dict):
        price = item.get('price')
        return (
            -(price if price is not None else -1),
            item.get('endTime') or '',
            item.get('domain') or '',
        )

    matches.sort(key=sort_key)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'scanned': scanned,
        'matches': matches,
    }
    args.out.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.out), 'scanned': scanned, 'matches': len(matches)}, indent=2))


if __name__ == '__main__':
    main()
