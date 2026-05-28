#!/usr/bin/env python3
"""Ingest the latest emailed NameJet CSV from Gmail and emit filtered JSON rows."""

from __future__ import annotations

import json
import re
from base64 import urlsafe_b64decode
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from zoneinfo import ZoneInfo

from google.oauth2 import service_account
from googleapiclient.discovery import build

from domain_filters import allow_domain
from namejet_digest_filter import parse_rows

BASE = Path('/root/.openclaw/workspace')
DIGEST_DIR = BASE / 'namejet_digests'
OUTPUT_JSON = BASE / 'data/namejet_email_filtered.json'
GMAIL_CREDS = '/root/.secrets/google-gmail.json'
MAILBOX = 'stimpy@snagged.com'
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
SEARCH_QUERY = '(subject:"NameJet" OR subject:"NJ" OR from:namejet)'
MAX_RESULTS = 25
ET = ZoneInfo('America/New_York')


def decode_b64(data: str | None) -> bytes:
    if not data:
        return b''
    padding = '=' * (-len(data) % 4)
    try:
        return urlsafe_b64decode(data + padding)
    except Exception:
        return b''


def iter_parts(part: dict) -> Iterable[dict]:
    yield part
    for child in part.get('parts', []) or []:
        yield from iter_parts(child)


def get_header_map(payload: dict) -> dict[str, str]:
    return {
        str(h.get('name') or ''): str(h.get('value') or '')
        for h in payload.get('headers', []) or []
        if isinstance(h, dict)
    }


def decode_text_part(part: dict) -> str:
    body = part.get('body', {}) or {}
    data = body.get('data')
    return decode_b64(data).decode('utf-8', 'ignore') if data else ''


def parse_inline_alert(text: str, source_name: str) -> list[dict]:
    flattened = re.sub(r'\s+', ' ', text)
    pattern = re.compile(
        r'([a-z0-9-]+\.[a-z]{2,})\s*<https://www\.namejet\.com/domain/[^>]+>\*?\s*([0-9,]+)\s+(\d{2}/\d{2}/\d{4})\s+(\d{2}:\d{2})',
        re.IGNORECASE,
    )
    rows = []
    for domain, min_bid, close_date, close_time in pattern.findall(flattened):
        domain = domain.lower()
        if not allow_domain(domain):
            continue
        dt = datetime.strptime(f'{close_date} {close_time}', '%m/%d/%Y %H:%M').replace(tzinfo=ET)
        rows.append({
            'domain': domain,
            'word': domain.split('.', 1)[0],
            'status': 'Email Alert',
            'age': '',
            'traffic': '0',
            'bidders': '0',
            'min_bid': min_bid,
            'close_et': dt.isoformat(),
            'close_display': dt.strftime('%-I:%M %p ET'),
            'closing_dt_utc': dt.astimezone(timezone.utc).isoformat(),
            'link': f'https://www.namejet.com/domain/{domain}.action',
            'source_csv': source_name,
        })
    deduped = {row['domain']: row for row in rows}
    return sorted(deduped.values(), key=lambda row: row['closing_dt_utc'])


def download_attachment(service, message_id: str, attachment_id: str) -> bytes:
    resp = service.users().messages().attachments().get(
        userId='me', messageId=message_id, id=attachment_id
    ).execute()
    return decode_b64(resp.get('data'))


def find_latest_source(service) -> tuple[Path | None, list[dict] | None]:
    DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    resp = service.users().messages().list(
        userId='me', q=SEARCH_QUERY, maxResults=MAX_RESULTS
    ).execute()
    items = resp.get('messages', [])
    for item in items:
        full = service.users().messages().get(userId='me', id=item['id'], format='full').execute()
        payload = full.get('payload', {})
        headers = get_header_map(payload)
        msg_id = item['id']
        for part in iter_parts(payload):
            filename = str(part.get('filename') or '').strip()
            body = part.get('body', {}) or {}
            attachment_id = body.get('attachmentId')
            if filename.lower().endswith('.csv') and attachment_id:
                raw = download_attachment(service, msg_id, attachment_id)
                if not raw:
                    continue
                safe_name = filename.replace('/', '_')
                out = DIGEST_DIR / safe_name
                out.write_bytes(raw)
                latest = DIGEST_DIR / 'latest_namejet_digest.csv'
                latest.write_bytes(raw)
                meta = {
                    'messageId': msg_id,
                    'subject': headers.get('Subject', ''),
                    'date': headers.get('Date', ''),
                    'filename': safe_name,
                    'savedPath': str(out),
                }
                (DIGEST_DIR / 'latest_namejet_digest_meta.json').write_text(json.dumps(meta, indent=2))
                return out, None

        for part in iter_parts(payload):
            if part.get('mimeType') != 'text/plain':
                continue
            text = decode_text_part(part)
            if 'NameJet' not in text or 'domain names are available for backorder' not in text:
                continue
            source_name = f"inline_{msg_id}.txt"
            (DIGEST_DIR / 'latest_namejet_alert.txt').write_text(text)
            rows = parse_inline_alert(text, source_name)
            if rows:
                meta = {
                    'messageId': msg_id,
                    'subject': headers.get('Subject', ''),
                    'date': headers.get('Date', ''),
                    'filename': source_name,
                    'savedPath': str(DIGEST_DIR / 'latest_namejet_alert.txt'),
                }
                (DIGEST_DIR / 'latest_namejet_digest_meta.json').write_text(json.dumps(meta, indent=2))
                return None, rows

    latest = DIGEST_DIR / 'latest_namejet_digest.csv'
    if latest.exists():
        return latest, None
    csvs = sorted(DIGEST_DIR.glob('*.csv'), key=lambda p: p.stat().st_mtime, reverse=True)
    if csvs:
        return csvs[0], None
    alert_txt = DIGEST_DIR / 'latest_namejet_alert.txt'
    if alert_txt.exists():
        rows = parse_inline_alert(alert_txt.read_text(), alert_txt.name)
        if rows:
            return None, rows
    return None, None


def main() -> None:
    creds = service_account.Credentials.from_service_account_file(
        GMAIL_CREDS, scopes=SCOPES, subject=MAILBOX
    )
    service = build('gmail', 'v1', credentials=creds)
    csv_path, inline_rows = find_latest_source(service)
    if csv_path and csv_path.exists():
        rows = parse_rows(csv_path)
        payload = []
        for row in rows:
            item = asdict(row)
            item['closing_dt_utc'] = datetime.fromisoformat(row.close_et).astimezone(timezone.utc).isoformat()
            item['min_bid_value'] = row.min_bid
            item['link'] = f"https://www.namejet.com/domain/{row.domain}.action"
            item['source_csv'] = csv_path.name
            payload.append(item)
        OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_JSON.write_text(json.dumps(payload, indent=2))
        print(f'Parsed {len(payload)} qualifying NameJet email rows from {csv_path.name} -> {OUTPUT_JSON}')
        return

    if inline_rows is not None:
        OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_JSON.write_text(json.dumps(inline_rows, indent=2))
        print(f'Parsed {len(inline_rows)} qualifying NameJet inline email rows -> {OUTPUT_JSON}')
        return

    OUTPUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_JSON.write_text('[]\n')
    print('No NameJet digest data found in Gmail or local cache.')


if __name__ == '__main__':
    main()
