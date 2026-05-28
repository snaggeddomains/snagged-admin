#!/usr/bin/env python3
"""Fetch NameSilo auctions, apply our filters, and store structured JSON."""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import List

import requests

from domain_filters import allow_domain

API_ENDPOINT = "https://www.namesilo.com/public/api/listAuctions"
API_KEY_PATH = Path(".secrets/namesilo_api_key.txt")
OUTPUT_PATH = Path("data/namesilo_auctions_filtered.json")
DEFAULT_HOURS = 48
PAGE_SIZE = 500
DEFAULT_MAX_PAGES = 150
DEFAULT_JUMP_PAGES = 25
MAX_SEARCH_PAGE = 5000
STATUS_ACTIVE = 2  # Expired domain active status ID
TYPE_EXPIRED = 3   # Expired domain auction type ID


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fetch/filter NameSilo auctions")
    parser.add_argument("--hours", type=int, default=DEFAULT_HOURS, help="How far ahead to keep auctions")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, help="Maximum sequential pages to scan once in range")
    parser.add_argument("--jump-pages", type=int, default=DEFAULT_JUMP_PAGES, help="Page jump size when fast-forwarding past stale data")
    parser.add_argument("--out", type=Path, default=OUTPUT_PATH, help="Where to write the filtered JSON")
    return parser.parse_args()


def load_api_key() -> str:
    if not API_KEY_PATH.exists():
        raise FileNotFoundError("NameSilo API key not found at .secrets/namesilo_api_key.txt")
    return API_KEY_PATH.read_text().strip()


def fetch_page(session: requests.Session, key: str, page: int) -> List[dict]:
    params = {
        "version": 1,
        "type": "json",
        "key": key,
        "statusId": STATUS_ACTIVE,
        "typeId": TYPE_EXPIRED,
        "page": page,
        "pageSize": PAGE_SIZE,
        "orderBy": "auctionEndsOn",
        "orderType": "ASC",
    }
    for attempt in range(5):
        resp = session.get(API_ENDPOINT, params=params, timeout=60)
        if resp.status_code == 429 and attempt < 4:
            time.sleep(1.5 * (attempt + 1))
            continue
        resp.raise_for_status()
        data = resp.json()
        reply = data.get("reply", {})
        body = reply.get("body", [])
        return body
    return []


def parse_time(text: str | None) -> datetime | None:
    if not text:
        return None
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        # NameSilo sometimes omits "T" between date/time
        text = text.replace(" ", "T")
        try:
            dt = datetime.fromisoformat(text)
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt


def determine_start_page(session: requests.Session, api_key: str, now: datetime, jump: int) -> int:
    page = 1
    jump = max(1, jump)
    while page <= MAX_SEARCH_PAGE:
        rows = fetch_page(session, api_key, page)
        if not rows:
            break
        last_end = parse_time(rows[-1].get("auctionEndsOnUtc") or rows[-1].get("auctionEndsOn"))
        if last_end and last_end >= now:
            start = max(1, page - jump)
            print(f"Fast-forwarded to page {start} (threshold hit at page {page})", flush=True)
            return start
        page += jump
        time.sleep(0.2)
    return 1


def main() -> None:
    args = parse_args()
    api_key = load_api_key()
    session = requests.Session()

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=args.hours)

    matches: list[dict] = []
    max_pages = max(1, args.max_pages)
    start_page = determine_start_page(session, api_key, now, args.jump_pages)

    page = start_page
    processed = 0

    while processed < max_pages and page <= MAX_SEARCH_PAGE:
        rows = fetch_page(session, api_key, page)
        if not rows:
            break
        last_end = parse_time(rows[-1].get("auctionEndsOnUtc") or rows[-1].get("auctionEndsOn"))
        if last_end and last_end < now:
            page += 1
            continue
        first_end = parse_time(rows[0].get("auctionEndsOnUtc") or rows[0].get("auctionEndsOn"))
        if first_end and first_end > cutoff:
            break
        for row in rows:
            domain = (row.get("domainName") or row.get("domain") or "").lower()
            if not domain or not allow_domain(domain):
                continue
            end_time = parse_time(row.get("auctionEndsOnUtc") or row.get("auctionEndsOn"))
            if not end_time:
                continue
            if not (now <= end_time <= cutoff):
                continue
            matches.append(
                {
                    "domain": domain,
                    "price": row.get("currentBid") or row.get("openingBid"),
                    "bidCount": row.get("bidsQuantity"),
                    "endTime": end_time.isoformat(),
                    "link": row.get("url"),
                }
            )
        processed += 1
        if processed % 20 == 0:
            print(f"Processed {processed} pages starting at page {start_page}", flush=True)
        page += 1
        time.sleep(0.3)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": now.isoformat(),
        "match_count": len(matches),
        "matches": matches,
    }
    args.out.write_text(json.dumps(payload, indent=2))
    print(f"Wrote {len(matches)} NameSilo auctions -> {args.out}")


if __name__ == "__main__":
    main()
