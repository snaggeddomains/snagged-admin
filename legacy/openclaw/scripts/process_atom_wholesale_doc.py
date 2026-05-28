#!/usr/bin/env python3
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build
from wordfreq import zipf_frequency
from zoneinfo import ZoneInfo

from score_utils import compute_deal_score
from word_rules import is_clean_word

BASE = Path('/root/.openclaw/workspace')
SERVICE_ACCOUNT = BASE / '.secrets/google_service_account.json'
SLACK_TOKEN_PATH = BASE / '.secrets/slack-bot-token.txt'
DOC_ID = '1-n-fiAOfTf9e5NaVSHCdgyNRTKdPuPBRx2A9XqwzczU'
SHEET_ID = '1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw'
SHEET_TAB = 'Running'
TOP_INSERT_RANGE = f"'{SHEET_TAB}'!A2"  # hard-coded write target after explicit top-row insertion
SLACK_CHANNEL = 'C09B1P21YQ0'  # #snap
SHEET_URL = f'https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit'
TZ = ZoneInfo('America/New_York')
SCOPES = [
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets',
]
TLD_WEIGHTS = {
    '.com': 1.0,
    '.ai': 0.9,
    '.io': 0.7,
    '.co': 0.7,
    '.org': 0.6,
    '.net': 0.55,
    '.now': 0.45,
    '.me': 0.4,
    '.vc': 0.35,
}
MIN_ZIPF = 2.8


@dataclass
class Entry:
    domain: str
    price_value: float
    price_text: str
    notes: str
    page: int
    row_on_page: int
    raw_text: str

    @property
    def sld(self) -> str:
        return self.domain.split('.', 1)[0]

    @property
    def tld(self) -> str:
        return '.' + self.domain.split('.', 1)[1].lower()


def sheets_service():
    creds = service_account.Credentials.from_service_account_file(str(SERVICE_ACCOUNT), scopes=SCOPES)
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)


def docs_service():
    creds = service_account.Credentials.from_service_account_file(str(SERVICE_ACCOUNT), scopes=SCOPES)
    return build('docs', 'v1', credentials=creds, cache_discovery=False)


def read_doc_paragraphs() -> list[str]:
    doc = docs_service().documents().get(documentId=DOC_ID).execute()
    out: list[str] = []
    for block in doc.get('body', {}).get('content', []):
        para = block.get('paragraph')
        if not para:
            continue
        parts = []
        for el in para.get('elements', []):
            tr = el.get('textRun')
            if tr:
                parts.append(tr.get('content', ''))
        text = ''.join(parts).strip()
        if text:
            out.append(text)
    return out


def parse_price(text: str) -> tuple[float, str] | None:
    m = re.search(r'\$\s*([0-9,]+(?:\.[0-9]{2})?)', text)
    if not m:
        return None
    raw = m.group(1)
    return float(raw.replace(',', '')), f'${raw}'


def parse_entries(paragraphs: Iterable[str]) -> list[Entry]:
    items = list(paragraphs)
    entries: list[Entry] = []
    i = 0
    row_on_page = 0
    page = 1
    while i < len(items):
        domain = items[i].strip()
        if '.' not in domain or ' ' in domain:
            i += 1
            continue
        price_info = parse_price(items[i + 1]) if i + 1 < len(items) else None
        if not price_info:
            i += 1
            continue
        price_value, price_text = price_info
        notes = []
        j = i + 2
        while j < len(items) and items[j] != 'View Details':
            notes.append(items[j])
            j += 1
        if j >= len(items):
            i += 1
            continue
        row_on_page += 1
        entries.append(
            Entry(
                domain=domain.lower(),
                price_value=price_value,
                price_text=price_text,
                notes=' | '.join(notes),
                page=page,
                row_on_page=row_on_page,
                raw_text=' | '.join([domain, *notes, price_text, 'View Details']) if notes else f'{domain} | {price_text} | View Details',
            )
        )
        i = j + 1
    return entries


def brandability(zipf: float, length: int, tld_weight: float) -> float:
    length_bonus = max(0.0, 16 - length) * 2.2
    zipf_component = min(50.0, zipf * 12.5)
    tld_component = tld_weight * 28.0
    return round(zipf_component + length_bonus + tld_component, 1)


def deal_score(zipf: float, price_value: float, tld_weight: float) -> float:
    return round(compute_deal_score(zipf, price_value, max(tld_weight, 0.1)), 1)


def load_existing_domains() -> set[str]:
    svc = sheets_service()
    values = svc.spreadsheets().values().get(spreadsheetId=SHEET_ID, range=f"'{SHEET_TAB}'!A2:A").execute().get('values', [])
    return {row[0].strip().lower() for row in values if row and row[0].strip()}


def row_for_sheet(entry: Entry, today: str) -> list[object]:
    sld = entry.sld
    tld = entry.tld
    zipf = round(zipf_frequency(sld, 'en'), 1) if sld.isalpha() else 0.0
    weight = TLD_WEIGHTS.get(tld, 0.2)
    return [
        entry.domain,
        sld.capitalize(),
        tld.lstrip('.'),
        zipf,
        brandability(zipf, len(sld), weight),
        deal_score(zipf, entry.price_value, weight),
        f'${entry.price_value:,.2f}',
        'USD',
        'Atom Wholesale',
        today,
        str(entry.page),
        str(entry.row_on_page),
        entry.notes,
        entry.raw_text,
    ]


def append_rows(rows: list[list[object]]) -> int:
    if not rows:
        return 0
    svc = sheets_service()
    svc.spreadsheets().batchUpdate(
        spreadsheetId=SHEET_ID,
        body={
            'requests': [
                {
                    'insertDimension': {
                        'range': {
                            'sheetId': 0,
                            'dimension': 'ROWS',
                            'startIndex': 1,
                            'endIndex': 1 + len(rows),
                        },
                        'inheritFromBefore': False,
                    }
                }
            ]
        },
    ).execute()
    svc.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=TOP_INSERT_RANGE,
        valueInputOption='USER_ENTERED',
        body={'values': rows},
    ).execute()
    return len(rows)


def qualifying_entries(entries: Iterable[Entry]) -> list[dict]:
    qualified = []
    for entry in entries:
        sld = entry.sld
        if not sld.isalpha():
            continue
        zipf = zipf_frequency(sld, 'en')
        if zipf < MIN_ZIPF:
            continue
        if not is_clean_word(sld, MIN_ZIPF):
            continue
        tld_weight = TLD_WEIGHTS.get(entry.tld, 0.0)
        if tld_weight <= 0:
            continue
        qualified.append({
            'domain': entry.domain,
            'price': entry.price_value,
            'zipf': round(zipf, 2),
            'brandability': brandability(zipf, len(sld), tld_weight),
            'deal': deal_score(zipf, entry.price_value, tld_weight),
            'notes': entry.notes,
            'link': f"https://www.atom.com/ws/name/{entry.domain.split('.', 1)[0].capitalize()}{entry.tld}",
        })
    qualified.sort(key=lambda r: (r['deal'], r['brandability'], r['zipf']), reverse=True)
    return qualified


def slack_rows(entries: Iterable[Entry]) -> list[dict]:
    rows = []
    for entry in entries:
        sld = entry.sld
        tld_weight = TLD_WEIGHTS.get(entry.tld, 0.0)
        zipf = zipf_frequency(sld, 'en') if sld.isalpha() else 0.0
        clean = sld.isalpha() and zipf >= MIN_ZIPF and is_clean_word(sld, MIN_ZIPF) and tld_weight > 0
        rows.append({
            'domain': entry.domain,
            'price': entry.price_value,
            'zipf': round(zipf, 2) if sld.isalpha() else None,
            'deal': deal_score(zipf, entry.price_value, tld_weight) if clean else None,
            'qualified': clean,
            'link': f"https://www.atom.com/ws/name/{entry.domain.split('.', 1)[0].capitalize()}{entry.tld}",
        })
    return rows


def send_slack(rows: list[dict], appended: int) -> None:
    if not rows or not SLACK_TOKEN_PATH.exists():
        return
    token = SLACK_TOKEN_PATH.read_text().strip()
    lines = []
    for row in rows:
        metrics = []
        if row['zipf'] is not None:
            metrics.append(f"zipf {row['zipf']:.1f}")
        if row['deal'] is not None:
            metrics.append(f"deal {row['deal']:.1f}")
        if row['qualified']:
            metrics.append("SNAP")
        metric_text = f" — {' — '.join(metrics)}" if metrics else ''
        lines.append(
            f"• {row['domain']} — ${row['price']:,.0f}{metric_text} — <{row['link']}|link>"
        )
    text = (
        f"Atom Wholesale refresh, {appended} new rows appended to Running. All new rows:\n"
        + '\n'.join(lines)
        + f"\n\nFull sheet: <{SHEET_URL}|sheet>"
    )
    resp = requests.post(
        'https://slack.com/api/chat.postMessage',
        headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json; charset=utf-8'},
        json={'channel': SLACK_CHANNEL, 'text': text},
        timeout=30,
    )
    data = resp.json()
    if not data.get('ok'):
        raise RuntimeError(f'Slack error: {data}')


def main() -> None:
    paragraphs = read_doc_paragraphs()
    parsed = parse_entries(paragraphs)
    existing = load_existing_domains()
    now = datetime.now(TZ).date().isoformat()
    new_entries = [e for e in parsed if e.domain not in existing]
    rows = [row_for_sheet(e, now) for e in new_entries]
    appended = append_rows(rows)
    qualified = qualifying_entries(new_entries)
    slack_payload = slack_rows(new_entries)
    send_slack(slack_payload, appended)
    print(json.dumps({
        'parsed': len(parsed),
        'new_entries': len(new_entries),
        'appended': appended,
        'qualified': len(qualified),
        'topQualified': qualified[:10],
        'slackRows': slack_payload,
    }, indent=2))


if __name__ == '__main__':
    main()
