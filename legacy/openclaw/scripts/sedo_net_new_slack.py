#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build

from domain_filters import allow_domain

BASE = Path('/root/.openclaw/workspace')
SEDO_CSV = BASE / 'data/sedo/expiring_latest.csv'
STATE_PATH = BASE / 'data/sedo/net_new_state.json'
TOKEN_PATH = BASE / '.secrets/slack-bot-token.txt'
CHANNEL = 'C09B1P21YQ0'  # #snap
TZ_ET = ZoneInfo('America/New_York')
UTC = ZoneInfo('UTC')
SERVICE_ACCOUNT_FILE = BASE / '.secrets/google-service-account.json'
SHEET_ID = '1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8'
SHEET_TAB = 'Sedo Net-New'


def parse_float(value: str | None) -> float | None:
    if value in (None, ''):
        return None
    try:
        return float(str(value).replace('$', '').replace(',', '').strip())
    except ValueError:
        return None


def parse_end(value: str | None) -> str | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00')).replace(tzinfo=None)
        dt = dt.replace(tzinfo=UTC)
        return dt.isoformat()
    except Exception:
        try:
            dt = datetime.strptime(str(value), '%Y-%m-%d %H:%M:%S').replace(tzinfo=UTC)
            return dt.isoformat()
        except Exception:
            return str(value)


def to_et(value: str | None) -> str:
    if not value:
        return '—'
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return dt.astimezone(TZ_ET).strftime('%-m/%-d %-I:%M %p ET')
    except Exception:
        return str(value)


def load_rows() -> list[dict]:
    if not SEDO_CSV.exists():
        return []
    with SEDO_CSV.open(newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    cleaned: list[dict] = []
    for row in rows:
        domain = (row.get('Domain Ace') or '').strip().lower()
        if not domain or not allow_domain(domain):
            continue
        tld = (row.get('Tld') or '').strip().lower()
        price = parse_float(row.get('Current Bid'))
        currency = (row.get('Currency') or '').strip() or 'USD'
        end_iso = parse_end(row.get('Auction End Date'))
        cleaned.append({
            'domain': domain,
            'tld': tld,
            'price': price,
            'currency': currency,
            'end_ts': end_iso,
            'url': f'https://sedo.com/search/details/?domain={domain}',
        })
    return cleaned


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def save_state(rows: list[dict]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'updated_at': datetime.now(UTC).isoformat(),
        'domains': sorted({row['domain'] for row in rows}),
    }
    STATE_PATH.write_text(json.dumps(payload, indent=2))


def format_price(price: float | None, currency: str) -> str:
    if price is None:
        return '—'
    if float(price).is_integer():
        return f'{currency} {int(price):,}'
    return f'{currency} {price:,.2f}'.rstrip('0').rstrip('.')


def send_slack(text: str) -> None:
    if not TOKEN_PATH.exists():
        raise SystemExit('Missing Slack token')
    token = TOKEN_PATH.read_text().strip()
    resp = requests.post(
        'https://slack.com/api/chat.postMessage',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8',
        },
        json={'channel': CHANNEL, 'text': text},
        timeout=30,
    )
    data = resp.json()
    if not data.get('ok'):
        raise RuntimeError(f'Slack error: {data}')


def sheet_service():
    creds = service_account.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT_FILE), scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def ensure_sheet(service) -> int:
    meta = service.spreadsheets().get(spreadsheetId=SHEET_ID).execute()
    for sheet in meta.get('sheets', []):
        props = sheet.get('properties', {})
        if props.get('title') == SHEET_TAB:
            return props['sheetId']
    reply = service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={'requests': [{'addSheet': {'properties': {'title': SHEET_TAB}}}]},
    ).execute()
    return reply['replies'][0]['addSheet']['properties']['sheetId']


def sync_sheet(rows: list[dict]) -> str:
    service = sheet_service()
    gid = ensure_sheet(service)
    values = [[
        'Domain',
        'Auction End (ET)',
        'Price',
        'Link',
    ]]
    sorted_rows = sorted(rows, key=lambda row: ((row.get('price') or -1), row.get('domain')), reverse=True)
    for row in sorted_rows:
        values.append([
            row['domain'],
            to_et(row.get('end_ts')),
            format_price(row.get('price'), row.get('currency') or 'USD'),
            row.get('url') or '',
        ])
    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=f"'{SHEET_TAB}'!A:D",
        body={},
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=f"'{SHEET_TAB}'!A1",
        valueInputOption='RAW',
        body={'values': values},
    ).execute()
    return f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid={gid}'


def build_message(new_rows: list[dict], total_rows: int, sheet_url: str) -> str:
    now_et = datetime.now(TZ_ET).strftime('%-m/%-d %-I:%M %p ET')
    lines = [f'Sedo net-new check ({now_et}): {len(new_rows)} new names matched our filters, {total_rows} current filtered names total.']
    for row in new_rows:
        lines.append(
            f'• {row["domain"]} - {to_et(row.get("end_ts"))} - {format_price(row.get("price"), row.get("currency") or "USD")} - <{row.get("url")}|link>'
        )
    lines.append(f'')
    lines.append(f'Full sheet: <{sheet_url}|sheet>')
    return '\n'.join(lines)


def main() -> None:
    rows = load_rows()
    sheet_url = sync_sheet(rows)
    current_domains = {row['domain'] for row in rows}
    state = load_state()
    previous_domains = set(state.get('domains') or [])
    new_rows = [row for row in rows if row['domain'] not in previous_domains]
    new_rows.sort(key=lambda row: ((row.get('price') or -1), row.get('domain')), reverse=True)
    if new_rows:
        send_slack(build_message(new_rows, len(rows), sheet_url))
        print(f'Sent Sedo net-new Slack update with {len(new_rows)} names.')
    else:
        print(f'No Sedo net-new names. Current filtered set: {len(rows)} domains.')
    save_state(rows)


if __name__ == '__main__':
    main()
