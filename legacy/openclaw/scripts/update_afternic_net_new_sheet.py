#!/usr/bin/env python3
"""Push Afternic net-new domains into the Google Sheet tracker."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parents[1]
CURRENT_PATH = BASE_DIR / 'data' / 'afternic_top_250.json'
PREVIOUS_PATH = BASE_DIR / 'data' / 'afternic_top_250.prev.json'
NET_NEW_PATH = BASE_DIR / 'data' / 'afternic_net_new.json'
DIFF_PATH = BASE_DIR / 'data' / 'afternic_diff.json'
SERVICE_ACCOUNT_CANDIDATES = [
    BASE_DIR / '.secrets' / 'google_service_account.json',
    Path('/root/.secrets/google_service_account.json'),
    Path('/root/.secrets/google-gmail.json'),
]
SHEET_ID = '1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8'
SHEET_NAME = 'Running Good Deals'
SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

HEADER = [
    'domain',
    'price',
    'tld',
    'zipf_score',
    'fast_transfer',
    'quality_score',
    'deal_score',
    'link',
    'date_added'
]


def load_entries(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return []


def format_price(value: float | int) -> str:
    try:
        price = float(value)
    except (TypeError, ValueError):
        return ''
    if price >= 1000:
        return f"${price:,.0f}"
    if price.is_integer():
        return f"${int(price)}"
    return f"${price:,.2f}"


def format_number(value: float | int, digits: int = 3) -> str:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return ''
    fmt = f"{{:.{digits}f}}"
    return fmt.format(num).rstrip('0').rstrip('.') if digits else str(num)


def normalize_tld(entry: dict) -> str:
    tld = (entry.get('tld') or '').strip()
    return tld.lstrip('.')


def fast_label(value) -> str:
    text = str(value).strip().lower()
    return 'YES' if text in {'1', 'true', 'yes', 'fast', 'y'} else 'NO'


def entry_to_row(entry: dict, date_added: str = '') -> list[str]:
    domain = entry.get('domain', '')
    price = format_price(entry.get('price'))
    tld = normalize_tld(entry)
    zipf_score = format_number(entry.get('freq'), 2)
    quality = format_number(entry.get('quality_score'), 3)
    deal = format_number(entry.get('deal_score'), 1)
    link = str(entry.get('link') or f"https://www.afternic.com/domain/{domain}").strip()
    return [
        domain,
        price,
        tld,
        zipf_score,
        fast_label(entry.get('fast')),
        quality,
        deal,
        link,
        date_added
    ]


def resolve_service_account_path() -> Path:
    for path in SERVICE_ACCOUNT_CANDIDATES:
        if path.exists():
            return path
    checked = ', '.join(str(path) for path in SERVICE_ACCOUNT_CANDIDATES)
    raise FileNotFoundError(f'Missing Google service-account credentials. Checked: {checked}')


def get_service():
    creds = service_account.Credentials.from_service_account_file(
        str(resolve_service_account_path()), scopes=SCOPES
    )
    return build('sheets', 'v4', credentials=creds)


def fetch_existing_rows(service) -> list[list[str]]:
    resp = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=f'{SHEET_NAME}!A:I'
    ).execute()
    return resp.get('values', [])


def update_sheet(service, rows: list[list[str]]) -> int:
    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=f'{SHEET_NAME}!A:I'
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=f'{SHEET_NAME}!A1',
        valueInputOption='RAW',
        body={'values': rows}
    ).execute()
    return max(len(rows) - 1, 0)


def main() -> None:
    current = load_entries(CURRENT_PATH)
    previous = load_entries(PREVIOUS_PATH)
    current_map = {entry['domain']: entry for entry in current if entry.get('domain')}
    previous_domains = {entry.get('domain') for entry in previous if entry.get('domain')}

    net_new = [entry for domain, entry in current_map.items() if domain not in previous_domains]
    net_new.sort(key=lambda e: (e.get('deal_score') or 0, e.get('quality_score') or 0), reverse=True)

    if not net_new and DIFF_PATH.exists():
        try:
            diff_data = json.loads(DIFF_PATH.read_text())
            fallback = diff_data.get('new_domains') or []
        except json.JSONDecodeError:
            fallback = []
        if fallback:
            net_new = fallback
            net_new.sort(key=lambda e: (e.get('deal_score') or 0, e.get('quality_score') or 0), reverse=True)

    NET_NEW_PATH.parent.mkdir(parents=True, exist_ok=True)
    NET_NEW_PATH.write_text(json.dumps(net_new, indent=2))

    service = get_service()
    existing_values = fetch_existing_rows(service)

    existing_rows = []
    existing_domains = set()
    for row in existing_values[1:]:
        if not row:
            continue
        domain = (row[0] if len(row) > 0 else '').strip().lower()
        if not domain:
            continue
        padded = row + [''] * (len(HEADER) - len(row))
        existing_rows.append(padded[:len(HEADER)])
        existing_domains.add(domain)

    today_str = datetime.now(timezone.utc).date().isoformat()
    new_rows = []
    for entry in net_new:
        domain = (entry.get('domain') or '').strip().lower()
        if not domain or domain in existing_domains:
            continue
        new_rows.append(entry_to_row(entry, today_str))
        existing_domains.add(domain)

    rows = [HEADER]
    rows.extend(new_rows)
    rows.extend(existing_rows)

    update_sheet(service, rows)

    if new_rows:
        print(f"Added {len(new_rows)} new Afternic domains to the running sheet.")
    else:
        print('No net-new Afternic domains detected; sheet refreshed to ensure columns are current.')


if __name__ == '__main__':
    main()
