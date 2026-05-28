#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List

from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE = Path('/root/.openclaw/workspace')
sys.path.append(str(BASE / 'scripts'))

from afternic_diff import TOP_JSON  # type: ignore

SHEET_ID = '1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8'
RUNNING_TAB = 'Running Good Deals'
DIFF_TAB = "Today's New Listings"
STATE_PATH = BASE / 'data' / 'afternic_sublist_latest.json'
SERVICE_ACCOUNT_FILE = BASE / '.secrets/google_service_account.json'
MAX_ROWS = 600


def get_service():
    creds = service_account.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT_FILE), scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    return build('sheets', 'v4', credentials=creds)


def ensure_sheet(service, title: str) -> None:
    meta = service.spreadsheets().get(spreadsheetId=SHEET_ID, fields='sheets(properties(title))').execute()
    titles = {sheet['properties']['title'] for sheet in meta.get('sheets', [])}
    if title in titles:
        return
    service.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={'requests': [{'addSheet': {'properties': {'title': title}}}]}
    ).execute()


def format_entry(entry: Dict) -> Dict:
    domain = str(entry.get('domain') or '').strip().lower()
    tld = str(entry.get('tld') or '').strip().lstrip('.')
    link = str(entry.get('link') or f"https://www.afternic.com/domain/{domain}").strip()
    return {
        'domain': domain,
        'price': entry.get('price', ''),
        'tld': tld,
        'zipf_score': float(entry.get('freq') or entry.get('zipf_score') or 0),
        'fast_transfer': 'YES' if str(entry.get('fast') or entry.get('fast_transfer') or '').strip().lower() in {'1', 'yes', 'true'} else 'NO',
        'quality_score': float(entry.get('quality_score') or 0),
        'deal_score': float(entry.get('deal_score') or 0),
        'link': link,
        'date_added': datetime.now(timezone.utc).date().isoformat(),
    }


def select_entries() -> List[Dict]:
    if not TOP_JSON.exists():
        return []
    try:
        entries = json.loads(TOP_JSON.read_text())
    except json.JSONDecodeError:
        return []
    if not isinstance(entries, list):
        return []
    entries = [format_entry(entry) for entry in entries if isinstance(entry, dict) and entry.get('domain')]
    entries.sort(key=lambda e: (e['deal_score'], e['quality_score']), reverse=True)
    return entries[:MAX_ROWS]


def rows_from_entries(entries: List[Dict]) -> List[List[object]]:
    rows: List[List[object]] = []
    for e in entries:
        rows.append([
            e['domain'],
            e['price'],
            e['tld'],
            round(e['zipf_score'], 2),
            e['fast_transfer'],
            round(e['quality_score'], 3),
            round(e['deal_score'], 1),
            e['link'],
            e['date_added'],
        ])
    return rows


def load_previous() -> List[Dict]:
    if not STATE_PATH.exists():
        return []
    try:
        return json.loads(STATE_PATH.read_text())
    except json.JSONDecodeError:
        return []


def save_current(entries: List[Dict]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(entries, indent=2))


def build_diff_rows(current: List[Dict], previous: List[Dict]) -> tuple[List[List[object]], List[Dict]]:
    prev_map = {item['domain']: item for item in previous}
    curr_map = {item['domain']: item for item in current}
    prev_snapshot_date = previous[0]['date_added'] if previous else ''
    rows: List[List[object]] = []
    new_domains = sorted(curr_map.keys() - prev_map.keys(), key=lambda d: curr_map[d]['deal_score'], reverse=True)
    new_entries: List[Dict] = []
    for domain in new_domains:
        entry = curr_map[domain]
        new_entries.append(entry)
        rows.append([
            entry['domain'],
            entry['price'],
            entry['tld'],
            'Afternic',
            round(entry['zipf_score'], 2),
            round(entry['quality_score'], 3),
            round(entry['deal_score'], 1),
            entry['link'],
            entry['date_added'],
            prev_snapshot_date,
        ])
    return rows, new_entries


def range_for(tab: str, cols: str = 'A:I', start: str | None = None) -> str:
    needs_quote = ' ' in tab
    quoted = f"'{tab}'" if needs_quote else tab
    if start:
        return f"{quoted}!{start}"
    return f"{quoted}!{cols}"


def update_tab(service, tab: str, values: List[List[str]]) -> None:
    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=range_for(tab),
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=range_for(tab, start='A1'),
        valueInputOption='RAW',
        body={'values': values},
    ).execute()


def append_rows(service, tab: str, values: List[List[str]]) -> None:
    if not values:
        return
    service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=range_for(tab, start='A2'),
        valueInputOption='USER_ENTERED',
        insertDataOption='INSERT_ROWS',
        body={'values': values},
    ).execute()


def get_tab_rows(service, tab: str, cols: str) -> List[List[str]]:
    resp = service.spreadsheets().values().get(
        spreadsheetId=SHEET_ID,
        range=range_for(tab, cols=cols),
    ).execute()
    return resp.get('values', [])


def preserved_non_afternic_running_rows(service) -> List[List[object]]:
    existing = get_tab_rows(service, RUNNING_TAB, 'A:I')
    preserved: List[List[object]] = []
    for row in existing[1:]:
        if not row:
            continue
        padded = row + [''] * (9 - len(row))
        link = (padded[7] if len(padded) > 7 else '').strip().lower()
        if 'afternic.com/domain/' in link:
            continue
        preserved.append(padded[:9])
    return preserved


def replace_fresh_source_rows(service, source_label: str, report_date: str, new_rows: List[List[object]]) -> int:
    existing = get_tab_rows(service, DIFF_TAB, 'A:J')
    header = existing[0] if existing else [
        'domain', 'price', 'tld', 'source', 'zipf_score', 'quality_score', 'deal_score', 'link', 'date_added', 'prev_snapshot'
    ]

    kept_rows: List[List[object]] = []
    today_keys = set()
    source_label_lc = source_label.lower()

    for row in existing[1:]:
        if not row:
            continue
        padded = row + [''] * (10 - len(row))
        domain = padded[0].strip().lower()
        if not domain:
            continue
        source = padded[3].strip().lower()
        date_added = padded[8].strip()
        if source == source_label_lc:
            if domain and date_added == report_date:
                today_keys.add((domain, date_added))
                kept_rows.append(padded[:10])
            continue
        kept_rows.append(padded[:10])

    deduped_new = [row for row in new_rows if (str(row[0]).strip().lower(), str(row[8]).strip()) not in today_keys]
    final_rows = [header]
    final_rows.extend(deduped_new)
    final_rows.extend(kept_rows)

    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=range_for(DIFF_TAB, cols='A:J'),
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=range_for(DIFF_TAB, start='A1'),
        valueInputOption='USER_ENTERED',
        body={'values': final_rows},
    ).execute()
    return len(deduped_new)


def main() -> None:
    service = get_service()
    ensure_sheet(service, RUNNING_TAB)
    entries = select_entries()
    preserved_rows = preserved_non_afternic_running_rows(service)
    running_rows = [['domain', 'price', 'tld', 'zipf_score', 'fast_transfer', 'quality_score', 'deal_score', 'link', 'date_added']]
    running_rows.extend(rows_from_entries(entries))
    running_domains = {str(row[0]).strip().lower() for row in running_rows[1:] if row and str(row[0]).strip()}
    for row in preserved_rows:
        domain = str(row[0]).strip().lower()
        if domain and domain not in running_domains:
            running_rows.append(row)
            running_domains.add(domain)
    previous = load_previous()
    diff_rows, new_entries = build_diff_rows(entries, previous)
    update_tab(service, RUNNING_TAB, running_rows)
    fresh_added = replace_fresh_source_rows(service, 'Afternic', entries[0]['date_added'] if entries else datetime.now(timezone.utc).date().isoformat(), diff_rows)
    save_current(entries)
    print(f"Rebuilt running list ({len(running_rows) - 1} rows incl. preserved non-Afternic entries) and wrote {fresh_added} fresh Afternic rows.")


if __name__ == '__main__':
    main()
