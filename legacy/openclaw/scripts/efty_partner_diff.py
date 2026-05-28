#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path('/root/.openclaw/workspace')
DATA = BASE / 'data'
REVISIONS = DATA / 'revisions' / 'efty_partner'
OUT = DATA / 'efty_partner_diff.json'


def utc_day(offset_days: int = 0) -> str:
    return (datetime.utcnow() + timedelta(days=offset_days)).strftime('%Y%m%d')


def load_rows(path: Path) -> dict[str, dict[str, str]]:
    rows: dict[str, dict[str, str]] = {}
    with path.open(newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            domain = (row.get('domain_name') or '').strip().lower()
            if not domain:
                continue
            rows[domain] = {
                'domain': domain,
                'bin_price': (row.get('bin_price') or '').strip(),
                'currency': (row.get('currency') or '').strip(),
                'show_bin': (row.get('show_bin') or '').strip(),
                'show_make_offer': (row.get('show_make_offer') or '').strip(),
                'landing_page_url': (row.get('landing_page_url') or '').strip(),
            }
    return rows


def main() -> int:
    REVISIONS.mkdir(parents=True, exist_ok=True)
    prev_path = REVISIONS / f'efty_partner_{utc_day(-1)}.csv'
    curr_path = REVISIONS / f'efty_partner_{utc_day(0)}.csv'

    if not prev_path.exists():
        source = DATA / 'efty_partner_latest.csv'
        if not source.exists():
            raise FileNotFoundError(f'Missing prior snapshot source: {source}')
        prev_path.write_bytes(source.read_bytes())

    prev_rows = load_rows(prev_path)
    curr_rows = load_rows(curr_path)

    prev_keys = set(prev_rows)
    curr_keys = set(curr_rows)
    new_domains = sorted(curr_keys - prev_keys)
    removed_domains = sorted(prev_keys - curr_keys)
    price_changes = []
    other_changes = []

    for domain in sorted(prev_keys & curr_keys):
        old = prev_rows[domain]
        new = curr_rows[domain]
        if old['bin_price'] != new['bin_price']:
            price_changes.append({
                'domain': domain,
                'from': old['bin_price'],
                'to': new['bin_price'],
                'currency_from': old['currency'],
                'currency_to': new['currency'],
            })
        else:
            changed = {
                key: {'from': old[key], 'to': new[key]}
                for key in ('currency', 'show_bin', 'show_make_offer', 'landing_page_url')
                if old[key] != new[key]
            }
            if changed:
                other_changes.append({'domain': domain, 'changes': changed})

    result = {
        'previous_snapshot': str(prev_path),
        'current_snapshot': str(curr_path),
        'previous_count': len(prev_rows),
        'current_count': len(curr_rows),
        'new_count': len(new_domains),
        'removed_count': len(removed_domains),
        'price_change_count': len(price_changes),
        'other_change_count': len(other_changes),
        'new_domains': new_domains,
        'removed_domains': removed_domains,
        'price_changes': price_changes,
        'other_changes': other_changes,
    }
    OUT.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
