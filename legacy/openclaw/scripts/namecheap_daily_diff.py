#!/usr/bin/env python3
"""Compute the daily Namecheap exclusive BIN diff from the public CSV export."""
from __future__ import annotations

import csv
import hashlib
import json
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import List

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build
from wordfreq import zipf_frequency

from domain_filters import ALLOWED_TLDS, allow_domain, normalize_tld
from score_utils import compute_deal_score

BASE_DIR = Path(__file__).resolve().parents[1]
EXPORT_URL = 'https://d3ry1h4w5036x1.cloudfront.net/reports/Namecheap_Market_Sales_Buy_Now.csv'
CURRENT_CSV = BASE_DIR / 'data' / 'namecheap_buy_now_daily.csv'
PREVIOUS_CSV = BASE_DIR / 'data' / 'namecheap_buy_now_daily.prev.csv'
TOP_JSON = BASE_DIR / 'data' / 'namecheap_top_250.json'
CANDIDATES_JSON = BASE_DIR / 'data' / 'namecheap_top_candidates.json'
PREVIOUS_JSON = BASE_DIR / 'data' / 'namecheap_top_250.prev.json'
DIFF_JSON = BASE_DIR / 'data' / 'namecheap_diff.json'
STATE_JSON = BASE_DIR / 'data' / 'namecheap_sublist_latest.json'
SLACK_STATE_JSON = BASE_DIR / '.state' / 'namecheap_slack_post.json'
SHEET_ID = '1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8'
DIFF_TAB = "Today's New Listings"
SERVICE_ACCOUNT = BASE_DIR / '.secrets/google_service_account.json'
SLACK_TOKEN_PATH = BASE_DIR / '.secrets/slack-bot-token.txt'
SLACK_CHANNEL = 'C09B1P21YQ0'
SHEET_URL = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid=0'

TLD_WEIGHTS = {
    '.com': 1.0,
    '.ai': 0.9,
    '.io': 0.7,
    '.net': 0.7,
    '.co': 0.7,
    '.org': 0.6,
    '.me': 0.4,
}
DEFAULT_WEIGHT = 0.0
MIN_PRICE = 1.0
MIN_BIN_PRICE = 99.0
TOP_N = 250


@lru_cache(maxsize=None)
def freq(word: str) -> float:
    return zipf_frequency(word, 'en') if word else 0.0


@dataclass
class NamecheapEntry:
    domain: str
    price: float
    permalink: str
    freq: float
    tld: str
    weight: float
    quality: float
    deal: float
    sld_length: int

    @classmethod
    def from_row(cls, row: dict) -> 'NamecheapEntry | None':
        domain = (row.get('domain') or '').strip().lower()
        permalink = (row.get('permalink') or f'https://www.namecheap.com/market/buynow/{domain}/').strip()
        price_raw = row.get('price') or ''
        if not domain or not price_raw:
            return None
        try:
            price = float(str(price_raw).replace(',', ''))
        except ValueError:
            return None
        if price <= 0:
            price = MIN_PRICE
        if price < MIN_BIN_PRICE:
            return None
        if not allow_domain(domain, ALLOWED_TLDS):
            return None
        tld = normalize_tld(domain.split('.')[-1])
        weight = TLD_WEIGHTS.get(tld, DEFAULT_WEIGHT)
        if weight <= 0:
            return None
        label = domain.split('.')[0]
        score_freq = freq(label)
        if score_freq <= 0:
            return None
        quality = score_freq * weight
        deal = compute_deal_score(score_freq, price, weight)
        return cls(
            domain=domain,
            price=price,
            permalink=permalink,
            freq=score_freq,
            tld=tld,
            weight=weight,
            quality=quality,
            deal=deal,
            sld_length=len(label),
        )


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def download_export() -> Path:
    resp = requests.get(EXPORT_URL, timeout=180)
    resp.raise_for_status()
    CURRENT_CSV.parent.mkdir(parents=True, exist_ok=True)
    CURRENT_CSV.write_text(resp.text)
    return CURRENT_CSV


def load_inventory(path: Path) -> List[NamecheapEntry]:
    entries: List[NamecheapEntry] = []
    with path.open(encoding='utf-8', newline='') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            entry = NamecheapEntry.from_row(row)
            if entry:
                entries.append(entry)
    return entries


def load_raw_domains(path: Path) -> set[str]:
    if not path.exists():
        return set()
    domains: set[str] = set()
    with path.open(encoding='utf-8', newline='') as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            domain = (row.get('domain') or '').strip().lower()
            if domain:
                domains.add(domain)
    return domains


def entry_to_dict(entry: NamecheapEntry) -> dict:
    return {
        'domain': entry.domain,
        'price': entry.price,
        'freq': entry.freq,
        'tld': entry.tld,
        'weight': entry.weight,
        'quality_score': entry.quality,
        'deal_score': entry.deal,
        'sld_length': entry.sld_length,
        'link': entry.permalink,
    }


def load_previous_top() -> dict[str, dict]:
    source = PREVIOUS_JSON if PREVIOUS_JSON.exists() else TOP_JSON
    if not source.exists():
        return {}
    try:
        previous_list = json.loads(source.read_text())
    except json.JSONDecodeError:
        return {}
    return {item['domain']: item for item in previous_list if isinstance(item, dict) and item.get('domain')}


def build_sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT), scopes=['https://www.googleapis.com/auth/spreadsheets']
    )
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def range_for(tab: str, cols: str = 'A:I', start: str | None = None) -> str:
    quoted = f"'{tab}'" if ' ' in tab else tab
    return f'{quoted}!{start}' if start else f'{quoted}!{cols}'


def get_tab_rows(service, tab: str, cols: str) -> List[List[str]]:
    resp = service.spreadsheets().values().get(spreadsheetId=SHEET_ID, range=range_for(tab, cols=cols)).execute()
    return resp.get('values', [])




def load_previous_state() -> List[dict]:
    if not STATE_JSON.exists():
        return []
    try:
        return json.loads(STATE_JSON.read_text())
    except json.JSONDecodeError:
        return []


def save_current_state(entries: List[dict]) -> None:
    STATE_JSON.parent.mkdir(parents=True, exist_ok=True)
    STATE_JSON.write_text(json.dumps(entries, indent=2))


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
    final_rows = [header] + deduped_new + kept_rows
    service.spreadsheets().values().clear(spreadsheetId=SHEET_ID, range=range_for(DIFF_TAB, cols='A:J')).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=range_for(DIFF_TAB, start='A1'),
        valueInputOption='USER_ENTERED',
        body={'values': final_rows},
    ).execute()
    return len(deduped_new)


def send_slack_update(entries: List[dict], *, raw_new_count: int, filtered_entries: int, total_ranked: int, fresh_added: int, dropped_count: int, price_change_count: int) -> None:
    if not SLACK_TOKEN_PATH.exists():
        return
    token = SLACK_TOKEN_PATH.read_text().strip()
    lines = [
        'Namecheap exclusive daily diff is live.',
        f'Raw new names on the CSV diff: {raw_new_count:,}',
        f'Filtered names scanned into shortlist pool: {filtered_entries:,}',
        f'Ranked shortlist size: {total_ranked:,}',
        f"New qualifying names: {len(entries):,}",
        f"Rows added to Today\'s New Listings: {fresh_added:,}",
        f'Removals found: {dropped_count:,}',
        f'Price changes: {price_change_count:,}',
    ]
    if entries:
        lines.append('')
        lines.append('Top new qualifying names:')
        for entry in entries[:10]:
            price = f"${entry['price']:,.0f}" if float(entry['price']) >= 1000 else f"${float(entry['price']):.0f}"
            lines.append(f"• {entry['domain']} — {price} — quality {float(entry['quality_score']):.2f} — <{entry['link']}|link>")
    else:
        lines.append('')
        lines.append('0 met criteria today.')
    lines.append('')
    lines.append(f'Full sheet: <{SHEET_URL}|sheet>')
    text = '\n'.join(lines)
    fingerprint = hashlib.sha256(text.encode('utf-8')).hexdigest()
    if SLACK_STATE_JSON.exists():
        try:
            previous_post = json.loads(SLACK_STATE_JSON.read_text())
        except json.JSONDecodeError:
            previous_post = {}
        if previous_post.get('fingerprint') == fingerprint:
            print('Skipping duplicate Namecheap Slack post.')
            return
    resp = requests.post(
        'https://slack.com/api/chat.postMessage',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json; charset=utf-8'},
        json={'channel': SLACK_CHANNEL, 'text': text},
        timeout=30,
    )
    data = resp.json()
    if not data.get('ok'):
        raise RuntimeError(f'Slack error: {data}')
    SLACK_STATE_JSON.parent.mkdir(parents=True, exist_ok=True)
    SLACK_STATE_JSON.write_text(json.dumps({
        'fingerprint': fingerprint,
        'posted_at': datetime.now(timezone.utc).isoformat(),
    }, indent=2))


def main() -> None:
    previous_top = load_previous_top()
    previous_raw_domains = load_raw_domains(CURRENT_CSV)
    if TOP_JSON.exists():
        shutil.copy2(TOP_JSON, PREVIOUS_JSON)
    if CURRENT_CSV.exists():
        shutil.copy2(CURRENT_CSV, PREVIOUS_CSV)
    path = download_export()
    current_raw_domains = load_raw_domains(path)
    raw_new_count = len(current_raw_domains - previous_raw_domains)
    entries = load_inventory(path)
    by_deal = sorted(entries, key=lambda e: e.deal, reverse=True)[:TOP_N]
    by_quality = sorted(entries, key=lambda e: e.quality, reverse=True)[:TOP_N]
    combined: dict[str, NamecheapEntry] = {}
    for entry in by_quality + by_deal:
        combined[entry.domain] = entry
    ranked = sorted(combined.values(), key=lambda e: (e.quality, e.deal), reverse=True)
    top_dicts = [entry_to_dict(e) for e in ranked]
    save_json(TOP_JSON, top_dicts)
    save_json(CANDIDATES_JSON, top_dicts[:100])
    current_top = {item['domain']: item for item in top_dicts}
    new_domains = [current_top[d] for d in current_top.keys() - previous_top.keys()]
    dropped_domains = [previous_top[d] for d in previous_top.keys() - current_top.keys()]
    price_changes = []
    for domain in current_top.keys() & previous_top.keys():
        old = previous_top[domain]
        new = current_top[domain]
        if round(float(old.get('price', 0)), 2) != round(float(new.get('price', 0)), 2):
            price_changes.append({'domain': domain, 'old_price': old.get('price'), 'new_price': new.get('price')})
    diff_payload = {
        'total_ranked': len(top_dicts),
        'new_count': len(new_domains),
        'dropped_count': len(dropped_domains),
        'price_changes': price_changes,
        'new_domains': new_domains,
        'dropped_domains': dropped_domains,
    }
    save_json(DIFF_JSON, diff_payload)

    previous_state = load_previous_state()
    prev_map = {item['domain']: item for item in previous_state}
    date_added = datetime.now(timezone.utc).date().isoformat()
    current_entries = []
    for item in top_dicts:
        enriched = dict(item)
        enriched['date_added'] = date_added
        current_entries.append(enriched)
    current_map = {item['domain']: item for item in current_entries}
    new_rows = []
    new_entries_for_slack = []
    prev_snapshot = previous_state[0]['date_added'] if previous_state else ''
    for domain in sorted(current_map.keys() - prev_map.keys(), key=lambda d: current_map[d]['deal_score'], reverse=True):
        entry = current_map[domain]
        new_entries_for_slack.append(entry)
        new_rows.append([
            entry['domain'], entry['price'], entry['tld'].lstrip('.'), 'Namecheap', round(entry['freq'], 2),
            round(entry['quality_score'], 3), round(entry['deal_score'], 1), entry['link'], entry['date_added'], prev_snapshot,
        ])

    service = build_sheets_service()
    fresh_added = replace_fresh_source_rows(service, 'Namecheap', date_added, new_rows)
    save_current_state(current_entries)
    send_slack_update(
        new_entries_for_slack,
        raw_new_count=raw_new_count,
        filtered_entries=len(entries),
        total_ranked=len(top_dicts),
        fresh_added=fresh_added,
        dropped_count=len(dropped_domains),
        price_change_count=len(price_changes),
    )
    print(json.dumps({'raw_new_count': raw_new_count, 'filtered_entries': len(entries), 'total_ranked': len(top_dicts), 'fresh_added': fresh_added, 'new_count': len(new_entries_for_slack)}, indent=2))


if __name__ == '__main__':
    main()
