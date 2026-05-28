#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from pathlib import Path

from domain_filters import allow_domain

INPUT_PATH = Path("/tmp/dynadot_open.json")
OUTPUT_CSV = Path("/root/.openclaw/workspace/dynadot_filtered.csv")


def main() -> None:
    if not INPUT_PATH.exists():
        raise SystemExit(f"Input file not found: {INPUT_PATH}")

    data = json.loads(INPUT_PATH.read_text())

    rows = []
    if isinstance(data, dict):
        rows = (
            data.get("data", {}).get("auction_detail_info_list", [])
            or data.get("auctions", [])
            or data.get("results", [])
            or data.get("domains", [])
            or data.get("rows", [])
        )
    elif isinstance(data, list):
        rows = data

    filtered: list[dict] = []

    for row in rows:
        if not isinstance(row, dict):
            continue

        raw = row.get("raw") or {}

        domain = (
            row.get("domain")
            or row.get("name")
            or row.get("domain_name_utf")
            or row.get("utf_name")
            or raw.get("domain")
            or raw.get("utf_name")
        )

        if not domain:
            continue

        if not allow_domain(domain):
            continue

        filtered.append(
            {
                "end_time": (
                    row.get("end_time")
                    or row.get("endDate")
                    or row.get("end_date")
                    or row.get("end_time_utc")
                    or raw.get("end_time")
                    or raw.get("end_date")
                    or ""
                ),
                "domain": domain,
                "price": (
                    row.get("price")
                    or row.get("current_bid")
                    or row.get("min_bid")
                    or row.get("current_price")
                    or raw.get("current_bid_price")
                    or raw.get("price")
                    or ""
                ),
                "bids": (
                    row.get("bids")
                    or row.get("bidCount")
                    or row.get("bid_count")
                    or raw.get("bids")
                    or 0
                ),
                "url": (
                    row.get("url")
                    or row.get("sourceUrl")
                    or raw.get("url")
                    or (
                        f"https://www.dynadot.com/market/auction/{raw.get('auction_id')}.html"
                        if raw.get("auction_id")
                        else ""
                    )
                ),
            }
        )

    with OUTPUT_CSV.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(
            f, fieldnames=["end_time", "domain", "price", "bids", "url"]
        )
        writer.writeheader()
        writer.writerows(filtered)

    print(f"Wrote {len(filtered)} filtered Dynadot rows to {OUTPUT_CSV}")


if __name__ == "__main__":
    main()
