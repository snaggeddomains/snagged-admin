#!/usr/bin/env python3
"""Fetch Dynadot open auctions and save filtered rows for downstream filters."""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, Iterable, List

import requests

DEFAULT_OUT_PATH = Path('/tmp/dynadot_open.json')
SECRETS_PATH = Path('.secrets/dynadot.txt')
API_URL = 'https://api.dynadot.com/api3.json'
SUPPORTED_TYPES = ['expired']  # extend if we need other auction types


def load_kv_credentials(path: Path) -> Dict[str, str]:
    creds: Dict[str, str] = {}
    if not path.exists():
        raise FileNotFoundError(f'Missing credential file: {path}')
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if '=' in line:
            key, value = line.split('=', 1)
        elif ':' in line:
            key, value = line.split(':', 1)
        else:
            continue
        creds[key.strip().lower()] = value.strip()
    return creds


def fetch_page(api_key: str, api_secret: str, page_index: int, count_per_page: int,
               auction_types: Iterable[str]) -> Dict:
    params = {
        'key': api_key,
        'secret': api_secret,
        'command': 'get_open_auctions',
        'currency': 'usd',
        'type': ','.join(auction_types),
        'count_per_page': count_per_page,
        'page_index': page_index,
    }
    resp = requests.get(API_URL, params=params, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if data.get('status') != 'success':
        raise RuntimeError(f"Dynadot API error on page {page_index}: {data}")
    return data


def normalize_row(row: Dict) -> Dict:
    end_ts = row.get('end_time_stamp')
    end_iso = None
    if isinstance(end_ts, (int, float)):
        end_iso = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).isoformat()
    return {
        'domain_name_utf': row.get('utf_name') or row.get('domain', '').lower(),
        'current_price': row.get('current_bid_price'),
        'renewal_price': row.get('renewal_price'),
        'currency': row.get('currency'),
        'bids': row.get('bids'),
        'bidders': row.get('bidders'),
        'auction_type': row.get('auction_type'),
        'end_time_utc': end_iso,
        'end_time_stamp': end_ts,
        'time_left': row.get('time_left'),
        'dyna_appraisal': row.get('dyna_appraisal'),
        'visitors': row.get('visitors'),
        'links': row.get('links'),
        'age': row.get('age'),
        'raw': row,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description='Fetch Dynadot open auctions and filter by cutoff horizon.')
    parser.add_argument('--hours', type=float, default=24, help='Number of hours ahead to keep auctions (default: 24)')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT_PATH, help='Path to write the JSON payload')
    parser.add_argument('--page-size', type=int, default=99, help='Auctions per page (Dynadot currently allows up to 99)')
    parser.add_argument('--max-pages', type=int, default=10000, help='Safety limit on number of API pages to fetch')
    parser.add_argument('--types', type=str, default=','.join(SUPPORTED_TYPES), help='Comma-separated auction types to request')
    args = parser.parse_args()

    creds = load_kv_credentials(SECRETS_PATH)
    api_key = creds.get('api_key') or creds.get('key')
    api_secret = creds.get('api_secret') or creds.get('secret')
    if not api_key or not api_secret:
        raise RuntimeError('API key/secret not found in credentials file')

    cutoff_ts = (datetime.now(timezone.utc) + timedelta(hours=args.hours)).timestamp() * 1000
    cutoff_ts = int(cutoff_ts)

    all_filtered: List[Dict] = []
    total_rows = 0
    page_index = 1
    auction_types = [t.strip() for t in args.types.split(',') if t.strip()]

    pages_fetched = 0
    hit_max_pages = False

    while page_index <= args.max_pages:
        data = fetch_page(api_key, api_secret, page_index, args.page_size, auction_types)
        rows = data.get('auction_list', [])
        if not rows:
            break

        pages_fetched += 1
        total_rows += len(rows)

        filtered_page = []
        min_page_end = None
        max_page_end = None
        for row in rows:
            end_ts = row.get('end_time_stamp')
            if isinstance(end_ts, (int, float)):
                if min_page_end is None or end_ts < min_page_end:
                    min_page_end = end_ts
                if max_page_end is None or end_ts > max_page_end:
                    max_page_end = end_ts
                if end_ts <= cutoff_ts:
                    filtered_page.append(normalize_row(row))
            else:
                # Keep rows without timestamps just in case
                filtered_page.append(normalize_row(row))

        all_filtered.extend(filtered_page)

        # If this page is entirely beyond the cutoff horizon, no need to keep paging.
        if min_page_end is not None and min_page_end > cutoff_ts:
            break

        # If this page reaches or crosses the cutoff, keep going because later pages may still
        # contain additional auctions inside the horizon when ordering is not perfectly strict.
        if max_page_end is not None and max_page_end > cutoff_ts and not filtered_page:
            break

        page_index += 1
    else:
        hit_max_pages = True

    payload = {
        'meta': {
            'generated_at': datetime.now(timezone.utc).isoformat(),
            'cutoff_hours': args.hours,
            'cutoff_timestamp': cutoff_ts,
            'pages_fetched': pages_fetched,
            'total_rows': total_rows,
            'filtered_rows': len(all_filtered),
            'types': auction_types,
            'hit_max_pages': hit_max_pages,
            'max_pages': args.max_pages,
        },
        'data': {
            'auction_detail_info_list': all_filtered,
        },
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=2))
    print(f"Saved {len(all_filtered)} auctions (≤ {args.hours}h) to {args.out} from {total_rows} total rows across {pages_fetched} pages.")


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        sys.exit(1)
