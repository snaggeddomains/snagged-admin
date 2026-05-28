#!/usr/bin/env python3
"""Compute the daily Afternic BIN diff (quality + deal scores)."""

from __future__ import annotations

import csv
import json
import shutil
from dataclasses import asdict, dataclass
from functools import lru_cache
from urllib.parse import quote
from pathlib import Path
from typing import List

import requests
from wordfreq import zipf_frequency

from domain_filters import ALLOWED_TLDS, allow_domain, normalize_tld
from score_utils import compute_deal_score

BASE_DIR = Path(__file__).resolve().parents[1]
INVENTORY_CSV = BASE_DIR / 'data' / 'afternic' / 'inventory_latest.csv'
TOP_JSON = BASE_DIR / 'data' / 'afternic_top_250.json'
CANDIDATES_JSON = BASE_DIR / 'data' / 'afternic_top_candidates.json'
PREVIOUS_JSON = BASE_DIR / 'data' / 'afternic_top_250.prev.json'
DIFF_JSON = BASE_DIR / 'data' / 'afternic_diff.json'
SLACK_TOKEN_PATH = BASE_DIR / '.secrets/slack-bot-token.txt'
AFTERNIC_SHEET_URL = 'https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0'
AFTERNIC_CHANNEL = 'C09B1P21YQ0'  # #snap

TLD_WEIGHTS = {
    '.com': 1.0,
    '.ai': 0.9,
    '.io': 0.7,
    '.net': 0.7,
    '.co': 0.7,
    '.org': 0.6,
    '.computer': 0.3,
}

DEFAULT_WEIGHT = 0.0
MIN_PRICE = 1.0
MIN_BIN_PRICE = 99.0
TOP_N = 250
PROGRESS_INTERVAL = 50000


@lru_cache(maxsize=None)
def freq(word: str) -> float:
    return zipf_frequency(word, 'en') if word else 0.0


@dataclass
class AfternicEntry:
    domain: str
    price: float
    fast: str
    freq: float
    tld: str
    weight: float
    quality: float
    deal: float
    sld_length: int

    @classmethod
    def from_row(cls, row: dict) -> 'AfternicEntry | None':
        domain = (row.get('domain') or '').strip().lower()
        price_raw = row.get('price') or ''
        fast = (row.get('is-fast-transfer') or '0').strip()
        if not domain or not price_raw:
            return None
        try:
            price = float(price_raw)
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
        return cls(domain=domain, price=price, fast=fast, freq=score_freq,
                   tld=tld, weight=weight, quality=quality, deal=deal,
                   sld_length=len(label))


def load_inventory(path: Path) -> List[AfternicEntry]:
    entries: List[AfternicEntry] = []
    with path.open(newline='', encoding='utf-8') as fh:
        reader = csv.DictReader(fh)
        for idx, row in enumerate(reader, 1):
            entry = AfternicEntry.from_row(row)
            if entry:
                entries.append(entry)
            if idx % PROGRESS_INTERVAL == 0:
                print(f"Processed {idx:,} rows...", flush=True)
    print(f"Total filtered entries: {len(entries):,}")
    return entries


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def load_previous() -> dict[str, dict]:
    source = PREVIOUS_JSON if PREVIOUS_JSON.exists() else TOP_JSON
    if not source.exists():
        return {}
    try:
        previous_list = json.loads(source.read_text())
    except json.JSONDecodeError:
        return {}
    return {item['domain']: item for item in previous_list}


def entry_to_dict(entry: AfternicEntry) -> dict:
    return {
        'domain': entry.domain,
        'price': entry.price,
        'fast': entry.fast,
        'freq': entry.freq,
        'tld': entry.tld,
        'weight': entry.weight,
        'quality_score': entry.quality,
        'deal_score': entry.deal,
        'sld_length': entry.sld_length,
    }


def afternic_domain_link(domain: str) -> str:
    return f"https://www.afternic.com/domain/{quote(domain, safe='')}"


def send_slack_update(top_entries: List[dict]) -> None:
    if not top_entries:
        return
    if not SLACK_TOKEN_PATH.exists():
        return
    token = SLACK_TOKEN_PATH.read_text().strip()
    top_lines = []
    for entry in top_entries[:10]:
        price = f"${entry['price']:,.0f}" if entry['price'] >= 1000 else f"${entry['price']}"
        domain = entry['domain']
        top_lines.append(f"• <{afternic_domain_link(domain)}|{domain}> — {price} — quality {entry['quality_score']:.2f}")
    text = "Afternic quality-first refresh is live. Top movers:\n" + "\n".join(top_lines)
    text += f"\n\nFull sheet: {AFTERNIC_SHEET_URL}"
    resp = requests.post(
        'https://slack.com/api/chat.postMessage',
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json; charset=utf-8'
        },
        json={'channel': AFTERNIC_CHANNEL, 'text': text},
        timeout=30
    )
    data = resp.json()
    if not data.get('ok'):
        print(f"Slack error: {data}")


def main() -> None:
    previous = load_previous()
    if TOP_JSON.exists():
        shutil.copy2(TOP_JSON, PREVIOUS_JSON)
    entries = load_inventory(INVENTORY_CSV)

    by_deal = sorted(entries, key=lambda e: e.deal, reverse=True)[:TOP_N]
    by_quality = sorted(entries, key=lambda e: e.quality, reverse=True)[:TOP_N]

    combined: dict[str, AfternicEntry] = {}
    for entry in by_quality + by_deal:
        combined[entry.domain] = entry

    ranked = sorted(combined.values(), key=lambda e: (e.quality, e.deal), reverse=True)

    top_dicts = [entry_to_dict(e) for e in ranked]
    save_json(TOP_JSON, top_dicts)
    save_json(CANDIDATES_JSON, [entry_to_dict(e) for e in ranked[:100]])

    current = {item['domain']: item for item in top_dicts}

    new_domains = [current[d] for d in current.keys() - previous.keys()]
    dropped_domains = [previous[d] for d in previous.keys() - current.keys()]

    price_changes = []
    for domain in current.keys() & previous.keys():
        old = previous[domain]
        new = current[domain]
        if round(float(old.get('price', 0)), 2) != round(float(new.get('price', 0)), 2):
            price_changes.append({
                'domain': domain,
                'old_price': old.get('price'),
                'new_price': new.get('price')
            })

    diff_payload = {
        'total_ranked': len(top_dicts),
        'new_count': len(new_domains),
        'dropped_count': len(dropped_domains),
        'price_changes': price_changes,
        'new_domains': new_domains,
        'dropped_domains': dropped_domains
    }
    save_json(DIFF_JSON, diff_payload)

    send_slack_update(new_domains)

    print(json.dumps(diff_payload, indent=2))


if __name__ == '__main__':
    main()
