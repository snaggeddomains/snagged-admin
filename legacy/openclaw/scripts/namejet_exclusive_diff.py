#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = Path('/root/.openclaw/workspace')
LATEST = BASE / 'data/namejet/namejet_exclusive_latest.json'
PREVIOUS = BASE / 'data/namejet/namejet_exclusive_prev.json'
DIFF = BASE / 'data/namejet/namejet_exclusive_diff.json'
TZ_ET = ZoneInfo('America/New_York')


def load_snapshot(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return {}
    rows = data.get('rows') if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return {}
    snapshot: dict[str, dict] = {}
    for raw in rows:
        domain = ''
        end_utc = None
        min_bid = buy_now = None
        bidders = 0
        status = ''
        if isinstance(raw, dict):
            domain = (raw.get('DomainName') or '').strip().lower()
            end_utc = parse_order_by(raw.get('OrderBy'))
            min_bid = parse_money(raw.get('MinimumBid'))
            buy_now = parse_money(raw.get('BinPrice'))
            bidders = safe_int(raw.get('BidderCount'))
            status = (raw.get('Status') or '').strip()
        elif isinstance(raw, list) and len(raw) >= 10:
            domain = (raw[1] or '').strip().lower()
            end_utc = parse_order_by(raw[9])
            min_bid, buy_now = parse_amounts(raw[7])
            bidders = safe_int(raw[6])
            status = (raw[10] or '').strip()
        if not domain:
            continue
        entry = {
            'domain': domain,
            'end_utc': end_utc.isoformat() if end_utc else '',
            'min_bid': min_bid,
            'buy_now': buy_now,
            'bidders': bidders,
            'status': status,
        }
        snapshot[domain] = entry
    return snapshot


def parse_order_by(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.replace('\xa0', ' ').strip()
    if not value or value.lower() in {'available', 'available soon'}:
        return None
    try:
        return datetime.strptime(value, '%b %d, %Y %I:%M %p').replace(tzinfo=TZ_ET).astimezone(timezone.utc)
    except ValueError:
        return None


def parse_amounts(cell: str | None):
    if not cell:
        return None, None
    matches = re.findall(r'\$([\d,]+(?:\.\d+)?)', cell)
    values = []
    for match in matches:
        try:
            values.append(float(match.replace(',', '')))
        except ValueError:
            continue
    min_bid = values[0] if values else None
    buy_now = values[1] if len(values) > 1 else None
    return min_bid, buy_now


def parse_money(value: str | None):
    if not value:
        return None
    cleaned = value.replace('$', '').replace(',', '').strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def safe_int(value):
    try:
        return int(str(value).strip())
    except Exception:
        return 0


def save_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))


def main() -> None:
    current = load_snapshot(LATEST)
    if not current:
        raise SystemExit('No NameJet exclusive snapshot available')
    previous = load_snapshot(PREVIOUS)

    new_domains = sorted(current.keys() - previous.keys())
    dropped_domains = sorted(previous.keys() - current.keys())

    price_changes = []
    for domain in sorted(current.keys() & previous.keys()):
        curr = current[domain]
        prev = previous[domain]
        if curr['min_bid'] != prev.get('min_bid') or curr['buy_now'] != prev.get('buy_now'):
            price_changes.append({
                'domain': domain,
                'old_min_bid': prev.get('min_bid'),
                'new_min_bid': curr['min_bid'],
                'old_buy_now': prev.get('buy_now'),
                'new_buy_now': curr['buy_now']
            })

    diff_payload = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'total_domains': len(current),
        'new_domains': [current[d] for d in new_domains],
        'dropped_domains': [previous[d] for d in dropped_domains],
        'price_changes': price_changes,
    }
    save_json(DIFF, diff_payload)
    save_json(PREVIOUS, {'rows': list(current.values())})
    print(json.dumps({
        'total': len(current),
        'new_count': len(new_domains),
        'dropped_count': len(dropped_domains),
        'price_changes': len(price_changes)
    }, indent=2))


if __name__ == '__main__':
    main()
