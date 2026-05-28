#!/usr/bin/env python3
"""Download GoDaddy auction dumps and apply the shared filters."""
from __future__ import annotations

import argparse
import json
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from subprocess import run
from typing import Iterable

import requests

from domain_filters import allow_domain

BASE_URL = "https://inventory.auctions.godaddy.com/"
DUMPS = (
    "auctions_ending_today.json.zip",
    "auctions_ending_tomorrow.json.zip",
)
DEFAULT_OUTPUT = Path("data/godaddy_auctions_filtered.json")
DATA_DIR = Path("data/godaddy")
ROTATE_SCRIPT = Path("scripts/rotate_marketplace_dumps.py")


@dataclass
class AuctionRow:
    domain: str
    end_time: datetime
    price: float | None
    bids: int | None
    link: str | None


def download_zip(name: str) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    dest = DATA_DIR / name
    url = f"{BASE_URL}{name}"
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with dest.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 15):
                if chunk:
                    fh.write(chunk)
    return dest


def extract_json(zip_path: Path) -> list[dict]:
    rows: list[dict] = []
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.namelist():
            if not member.endswith(".json"):
                continue
            out_path = DATA_DIR / member
            zf.extract(member, path=DATA_DIR)
            with out_path.open() as fh:
                payload = json.load(fh)
            rows.extend(payload.get("data", []))
    return rows


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except Exception:
        return None


def parse_price(text: str | None) -> float | None:
    if not text:
        return None
    clean = text.replace("$", "").replace(",", "").strip()
    if not clean:
        return None
    try:
        return float(clean)
    except ValueError:
        return None


def filter_rows(rows: Iterable[dict], horizon_hours: int) -> list[AuctionRow]:
    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(hours=horizon_hours)
    kept: list[AuctionRow] = []
    for row in rows:
        if row.get("isAdult"):
            continue
        domain = (row.get("domainName") or "").lower()
        if not domain or not allow_domain(domain):
            continue
        end_time = parse_time(row.get("auctionEndTime"))
        if not end_time or not (now <= end_time <= cutoff):
            continue
        kept.append(
            AuctionRow(
                domain=domain,
                end_time=end_time,
                price=parse_price(row.get("price")),
                bids=row.get("numberOfBids"),
                link=row.get("link"),
            )
        )
    kept.sort(key=lambda r: r.end_time)
    return kept


def rotate_dumps() -> None:
    if ROTATE_SCRIPT.exists():
        run(["python3", str(ROTATE_SCRIPT)], check=False)


def main() -> None:
    parser = argparse.ArgumentParser(description="Filter GoDaddy dumps")
    parser.add_argument(
        "--hours",
        type=int,
        default=48,
        help="How far ahead (in hours) to consider",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Where to write the filtered JSON",
    )
    args = parser.parse_args()

    all_rows: list[dict] = []
    downloaded: list[str] = []
    for dump in DUMPS:
        zip_path = download_zip(dump)
        downloaded.append(str(zip_path))
        all_rows.extend(extract_json(zip_path))

    matches = filter_rows(all_rows, args.hours)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_files": downloaded,
        "match_count": len(matches),
        "matches": [
            {
                "domain": row.domain,
                "auctionType": "Bid",
                "endTime": row.end_time.isoformat(),
                "price": row.price,
                "bidCount": row.bids,
                "link": row.link,
            }
            for row in matches
        ],
    }
    args.out.write_text(json.dumps(payload, indent=2))
    rotate_dumps()
    print(f"Filtered {len(matches)} GoDaddy auctions (output -> {args.out})")


if __name__ == "__main__":
    main()
