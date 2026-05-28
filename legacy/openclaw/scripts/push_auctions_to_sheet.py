#!/usr/bin/env python3
"""Push the latest auction shortlist into the Google Sheet."""

from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Dict

from google.oauth2 import service_account
from googleapiclient.discovery import build
from zoneinfo import ZoneInfo

BASE = Path('/root/.openclaw/workspace')
SHEET_ID = '1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks'
SHEET_RANGE = 'Sheet1!A2:E'
SERVICE_ACCOUNT_FILE = BASE / '.secrets/google_service_account.json'
NAMEJET_EXCLUSIVE_PATH = BASE / 'data/namejet/namejet_exclusive_latest.json'
NAMEJET_EMAIL_PATH = BASE / 'data/namejet_email_filtered.json'
STATUS_PATH = BASE / 'data/auction_refresh_status.json'
DRIVE_UPLOADS_PATH = BASE / 'data/drive_uploads_filtered.json'

TZ_UTC = timezone.utc


def to_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith('Z'):
            value = value[:-1] + '+00:00'
        return datetime.fromisoformat(value)
    except Exception:
        return None


def format_price(value) -> str:
    if isinstance(value, (int, float)):
        return f"${value:,.2f}"
    if isinstance(value, str) and value:
        if value.startswith('$'):
            return value
        try:
            num = float(value.replace(',', ''))
            return f"${num:,.2f}"
        except Exception:
            return f"${value}"
    return ''


def time_left(end: datetime | None) -> str:
    if not end:
        return ''
    delta = end - datetime.now(timezone.utc)
    total_seconds = int(delta.total_seconds())
    sign = '-' if total_seconds < 0 else ''
    total_seconds = abs(total_seconds)
    hours, rem = divmod(total_seconds, 3600)
    minutes, seconds = divmod(rem, 60)
    return f"{sign}{hours}:{minutes:02d}:{seconds:02d}"


def load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def load_refresh_status() -> dict[str, dict]:
    data = load_json(STATUS_PATH)
    if not isinstance(data, dict):
        return {}
    sources = data.get('sources')
    if not isinstance(sources, dict):
        return {}
    return {
        str(key): value
        for key, value in sources.items()
        if isinstance(value, dict)
    }


def should_skip_source(refresh_status: dict[str, dict], key: str) -> tuple[bool, str]:
    meta = refresh_status.get(key) or {}
    status = str(meta.get('status') or '').lower()
    label = str(meta.get('label') or key)
    detail = str(meta.get('detail') or '').strip()
    if status == 'failed':
        message = f"Skipping {label} rows because this source failed during the current refresh"
        if detail:
            message = f"{message} ({detail})"
        return True, message
    if status in {'disabled', 'skipped'}:
        message = f"Skipping {label} rows for this run"
        if detail:
            message = f"{message} ({detail})"
        return True, message
    return False, ''


def parse_namecheap() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'namecheap_auctions_latest.json')
    if isinstance(data, dict):
        for item in data.get('matches', [])[:50]:
            dt = to_dt(item.get('endDate'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'Namecheap'
            })
    return rows


def parse_drive_uploads() -> List[Dict]:
    rows = []
    data = load_json(DRIVE_UPLOADS_PATH)
    if not isinstance(data, dict):
        return rows
    entries = data.get('rows', [])
    if not isinstance(entries, list):
        return rows
    for item in entries[:200]:
        if not isinstance(item, dict):
            continue
        dt = to_dt(item.get('closing_dt_utc'))
        source_file = (item.get('source_file') or '').strip()
        platform = (item.get('platform') or 'Drive Upload').strip()
        if source_file:
            platform = f"{platform}: {source_file}"
        rows.append({
            'end': dt,
            'domain': item.get('domain'),
            'price': format_price(item.get('min_bid_value')),
            'platform': platform,
        })
    return rows


def parse_dropcatch() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'dropcatch_auctions_latest.json')
    if isinstance(data, dict):
        for item in data.get('auctions', [])[:50]:
            dt = to_dt(item.get('endDate'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'DropCatch'
            })
    return rows


def parse_parkio() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'parkio_auctions_latest.json')
    if isinstance(data, dict):
        for item in data.get('auctions', [])[:50]:
            dt = to_dt(item.get('endDate'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'Park.io'
            })
    return rows


def parse_godaddy() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'data/godaddy_auctions_filtered.json')
    if isinstance(data, dict):
        for item in data.get('matches', [])[:50]:
            dt = to_dt(item.get('endTime'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'GoDaddy'
            })
    return rows


def parse_namesilo() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'data/namesilo_auctions_filtered.json')
    if isinstance(data, dict):
        for item in data.get('matches', [])[:50]:
            dt = to_dt(item.get('endTime'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'NameSilo'
            })
    return rows


def parse_sedo_expired() -> List[Dict]:
    rows = []
    data = load_json(BASE / 'data/sedo_expired_auctions.json')
    if isinstance(data, dict):
        for item in data.get('matches', [])[:50]:
            dt = to_dt(item.get('endTime'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('price')),
                'platform': 'Sedo Expired'
            })
    return rows


def parse_dynadot() -> List[Dict]:
    rows = []
    path = BASE / 'dynadot_filtered.csv'
    if not path.exists():
        return rows
    try:
        with path.open(newline='', encoding='utf-8-sig') as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                if not any((v or '').strip() for v in row.values()):
                    continue
                dt = to_dt(row.get('endDate') or row.get('end_time'))
                rows.append({
                    'end': dt,
                    'domain': row.get('domain') or row.get('name'),
                    'price': format_price(row.get('price') or row.get('bid')),
                    'platform': 'Dynadot'
                })
    except Exception:
        return rows
    return rows[:50]


def parse_namejet() -> List[Dict]:
    rows = []
    path = BASE / 'data/namejet_lastchance_full.json'
    data = load_json(path)
    if isinstance(data, list):
        data = sorted(data, key=lambda r: r.get('closing_dt_utc') or '')
        for item in data[:50]:
            dt = to_dt(item.get('closing_dt_utc'))
            rows.append({
                'end': dt,
                'domain': item.get('domain'),
                'price': format_price(item.get('min_bid')),
                'platform': 'NameJet'
            })
        return rows
    return rows


def parse_namejet_email() -> List[Dict]:
    rows = []
    data = load_json(NAMEJET_EMAIL_PATH)
    if not isinstance(data, list):
        return rows
    for item in data[:50]:
        dt = to_dt(item.get('closing_dt_utc') or item.get('close_et'))
        rows.append({
            'end': dt,
            'domain': item.get('domain'),
            'price': format_price(item.get('min_bid') or item.get('min_bid_value')),
            'platform': 'NameJet Email'
        })
    return rows


def parse_amounts(cell: str):
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


def parse_money(value: str):
    if not value:
        return None
    cleaned = value.replace('$', '').replace(',', '').strip()
    if not cleaned:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def parse_namejet_exclusive() -> List[Dict]:
    rows = []
    data = load_json(NAMEJET_EXCLUSIVE_PATH)
    if not isinstance(data, dict):
        return rows
    entries = data.get('rows', [])
    if not isinstance(entries, list):
        return rows
    tz = ZoneInfo('America/New_York')
    for raw in entries[:200]:
        domain = ''
        order_str = ''
        min_bid = buy_now = None
        if isinstance(raw, dict):
            domain = (raw.get('DomainName') or '').strip().lower()
            order_str = (raw.get('OrderBy') or '').replace('\xa0', ' ').strip()
            min_bid = parse_money(raw.get('MinimumBid'))
            buy_now = parse_money(raw.get('BinPrice'))
        elif isinstance(raw, list) and len(raw) >= 10:
            domain = (raw[1] or '').strip().lower()
            order_str = (raw[9] or '').replace('\xa0', ' ').strip()
            min_bid, buy_now = parse_amounts(raw[7])
        if not domain:
            continue
        dt = None
        if order_str and order_str.lower() not in {'available', 'available soon'}:
            try:
                dt = datetime.strptime(order_str, '%b %d, %Y %I:%M %p').replace(tzinfo=tz)
            except ValueError:
                dt = None
        price_val = min_bid if min_bid is not None else buy_now
        rows.append({
            'end': dt.astimezone(timezone.utc) if dt else None,
            'domain': domain,
            'price': format_price(price_val) if price_val is not None else '',
            'platform': 'NameJet Exclusive'
        })
    return rows


def gather_rows() -> List[List[str]]:
    all_rows = []
    refresh_status = load_refresh_status()
    for key, parser in [
        ('namecheap', parse_namecheap),
        ('drive_uploads', parse_drive_uploads),
        ('dynadot', parse_dynadot),
        ('dropcatch', parse_dropcatch),
        ('parkio', parse_parkio),
        ('godaddy', parse_godaddy),
        ('namesilo', parse_namesilo),
        ('sedo_expired', parse_sedo_expired),
        ('namejet_lastchance', parse_namejet),
        ('namejet_email', parse_namejet_email),
        ('namejet_exclusive', parse_namejet_exclusive),
    ]:
        skip, reason = should_skip_source(refresh_status, key)
        if skip:
            print(reason)
            continue
        all_rows.extend(parser())
    all_rows.sort(key=lambda r: r['end'] or datetime.max.replace(tzinfo=timezone.utc))
    formatted = []
    for item in all_rows:
        end = item['end']
        end_str = end.astimezone(TZ_UTC).strftime('%Y-%m-%d %H:%M:%S') if end else ''
        formatted.append([
            end_str,
            time_left(end),
            item.get('domain', ''),
            item.get('price', ''),
            item.get('platform', '')
        ])
    return formatted


def update_sheet(rows: List[List[str]]) -> None:
    creds = service_account.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT_FILE), scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    service = build('sheets', 'v4', credentials=creds)
    existing = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=SHEET_RANGE
    ).execute().get('values', [])
    combined = rows + existing
    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=SHEET_RANGE
    ).execute()
    if combined:
        service.spreadsheets().values().update(
            spreadsheetId=SHEET_ID,
            range='Sheet1!A2',
            valueInputOption='RAW',
            body={'values': combined}
        ).execute()


def main() -> None:
    rows = gather_rows()
    update_sheet(rows)
    print(f"Wrote {len(rows)} auction rows to the sheet")


if __name__ == '__main__':
    main()
