#!/usr/bin/env python3
"""Fetch Efty partner feed, normalize rows, and score good deals."""
from __future__ import annotations

import csv
import gzip
import io
import json
import os
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from wordfreq import zipf_frequency

from domain_filters import ALLOWED_TLDS, allow_domain, extract_sld, normalize_tld
from score_utils import compute_deal_score

BASE = Path('/root/.openclaw/workspace')
DATA_DIR = BASE / 'data'
REPORTS_DIR = BASE / 'reports' / 'efty_partner'
STATE_PATH = DATA_DIR / 'efty_partner_state.json'
LATEST_JSON = DATA_DIR / 'efty_partner_latest.json'
LATEST_CSV = DATA_DIR / 'efty_partner_latest.csv'
LATEST_GZ = DATA_DIR / 'efty_partner_latest.csv.gz'
TOP_JSON = DATA_DIR / 'efty_partner_top_deals.json'
TOKEN = os.environ.get('EFTY_PARTNER_TOKEN')
FEED_URL = f'https://efty.com/partner/feed/token/{TOKEN}/'
TIMEOUT = 180

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
MAX_TOP = 250

DOMAIN_KEYS = ('domain', 'name', 'domain_name', 'fqdn')
PRICE_KEYS = ('price', 'bin', 'buy_now', 'buy_now_price', 'asking_price', 'amount')
URL_KEYS = ('url', 'link', 'landing_page', 'landing_page_url', 'permalink')
STATUS_KEYS = ('sale_type', 'type', 'listing_type', 'status')
CATEGORY_KEYS = ('category', 'categories', 'tags', 'keywords')


@dataclass
class ScoredRow:
    domain: str
    price: float
    tld: str
    sld: str
    zipf_score: float
    quality_score: float
    deal_score: float
    link: str
    sale_type: str
    category: str
    raw: dict[str, Any]


def ensure_dirs() -> None:
    for p in (DATA_DIR, REPORTS_DIR):
        p.mkdir(parents=True, exist_ok=True)


def load_state() -> dict[str, Any]:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text())
        except Exception:
            return {}
    return {}


def save_state(state: dict[str, Any]) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def fetch_feed() -> bytes:
    resp = requests.get(
        FEED_URL,
        timeout=TIMEOUT,
        headers={
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'text/csv,application/octet-stream,*/*',
            'Accept-Encoding': 'gzip,deflate',
        },
    )
    if resp.status_code == 429:
        raise RuntimeError('Efty feed returned 429 rate limit')
    resp.raise_for_status()
    content = resp.content
    if resp.headers.get('content-encoding', '').lower() == 'gzip':
        try:
            content = gzip.decompress(content)
        except Exception:
            pass
    elif content[:2] == b'\x1f\x8b':
        content = gzip.decompress(content)
    return content


def decode_csv(raw: bytes) -> tuple[list[str], list[dict[str, str]]]:
    text = raw.decode('utf-8-sig', errors='replace')
    reader = csv.DictReader(io.StringIO(text))
    rows = [{(k or '').strip(): (v or '').strip() for k, v in row.items()} for row in reader]
    return list(reader.fieldnames or []), rows


def first_value(row: dict[str, Any], keys: tuple[str, ...]) -> str:
    lowered = {k.lower(): v for k, v in row.items()}
    for key in keys:
        if key in lowered and str(lowered[key]).strip():
            return str(lowered[key]).strip()
    return ''


def parse_price(raw: str) -> float:
    raw = (raw or '').strip()
    if not raw:
        return 0.0
    cleaned = raw.replace('$', '').replace(',', '').strip()
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def score_row(row: dict[str, str]) -> ScoredRow | None:
    domain = first_value(row, DOMAIN_KEYS).lower()
    if not domain or '.' not in domain:
        return None
    sld, tld = extract_sld(domain)
    tld = normalize_tld(tld)
    link = first_value(row, URL_KEYS) or f'https://{domain}'
    sale_type = first_value(row, STATUS_KEYS)
    category = first_value(row, CATEGORY_KEYS)
    price = parse_price(first_value(row, PRICE_KEYS))
    if price <= 0:
        price = MIN_PRICE
    weight = TLD_WEIGHTS.get(tld, DEFAULT_WEIGHT)
    zipf = zipf_frequency(sld, 'en') if sld else 0.0
    quality = round(zipf * weight, 3)
    deal = round(compute_deal_score(zipf, price, weight), 1)
    return ScoredRow(
        domain=domain,
        price=price,
        tld=tld,
        sld=sld,
        zipf_score=round(zipf, 3),
        quality_score=quality,
        deal_score=deal,
        link=link,
        sale_type=sale_type,
        category=category,
        raw=row,
    )


def rank_good_deals(rows: list[ScoredRow]) -> list[ScoredRow]:
    qualified = []
    for row in rows:
        if not allow_domain(row.domain, ALLOWED_TLDS):
            continue
        if TLD_WEIGHTS.get(row.tld, 0.0) <= 0:
            continue
        qualified.append(row)
    qualified.sort(key=lambda r: (r.deal_score, r.quality_score, r.zipf_score, -r.price), reverse=True)
    return qualified


def write_outputs(raw_bytes: bytes, headers: list[str], rows: list[dict[str, str]], scored: list[ScoredRow], ranked: list[ScoredRow]) -> Path:
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    report_path = REPORTS_DIR / f'efty_partner_ingest_{stamp}.json'
    LATEST_GZ.write_bytes(gzip.compress(raw_bytes))
    LATEST_CSV.write_bytes(raw_bytes)
    LATEST_JSON.write_text(json.dumps(rows, indent=2))
    TOP_JSON.write_text(json.dumps([asdict(r) for r in ranked[:MAX_TOP]], indent=2))
    report = {
        'fetched_at': now_iso(),
        'feed_url': FEED_URL,
        'headers': headers,
        'row_count': len(rows),
        'qualified_count': len(ranked),
        'top_25': [asdict(r) for r in ranked[:25]],
    }
    report_path.write_text(json.dumps(report, indent=2))
    return report_path


def main() -> int:
    ensure_dirs()
    state = load_state()
    try:
        raw = fetch_feed()
    except Exception as exc:
        state['last_attempt_at'] = now_iso()
        state['last_error'] = str(exc)
        save_state(state)
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
    headers, rows = decode_csv(raw)
    scored = [r for r in (score_row(row) for row in rows) if r is not None]
    ranked = rank_good_deals(scored)
    report_path = write_outputs(raw, headers, rows, scored, ranked)
    state.update({
        'last_attempt_at': now_iso(),
        'last_success_at': now_iso(),
        'last_error': None,
        'last_row_count': len(rows),
        'last_qualified_count': len(ranked),
        'last_headers': headers,
        'latest_report': str(report_path),
    })
    save_state(state)
    print(json.dumps({
        'ok': True,
        'row_count': len(rows),
        'qualified_count': len(ranked),
        'latest_report': str(report_path),
        'top_domains': [r.domain for r in ranked[:10]],
    }, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
