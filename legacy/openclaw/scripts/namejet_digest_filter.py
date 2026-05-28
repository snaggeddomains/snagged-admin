#!/usr/bin/env python3
"""Filter a NameJet digest CSV down to the allowed single-word targets."""

from __future__ import annotations

import argparse
import csv
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List
from zoneinfo import ZoneInfo

from domain_filters import ALLOWED_STATUSES, ALLOWED_TLDS, ZIPF_THRESHOLD, extract_sld, is_allowed_tld, min_zipf_for_tld, passes_word_filter

ET = ZoneInfo("America/New_York")


@dataclass
class DigestRow:
    domain: str
    word: str
    status: str
    age: str
    traffic: str
    bidders: str
    min_bid: str
    close_et: str
    close_display: str


def parse_rows(path: Path) -> List[DigestRow]:
    results: List[DigestRow] = []
    with path.open(newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            domain = (row.get("Domain Name") or "").strip().lower()
            if not domain or "." not in domain:
                continue
            sld, tld = extract_sld(domain)
            if not is_allowed_tld(tld, ALLOWED_TLDS):
                continue
            if not passes_word_filter(sld, min_zipf_for_tld(tld, ZIPF_THRESHOLD)):
                continue
            status = (row.get("Status") or "").strip()
            if status not in ALLOWED_STATUSES:
                continue
            order_str = (row.get("Order By") or "").strip()
            if not order_str:
                continue
            dt = datetime.strptime(order_str, "%b %d, %Y %I:%M:%S %p").replace(tzinfo=ET)
            results.append(
                DigestRow(
                    domain=domain,
                    word=sld,
                    status=status,
                    age=(row.get("Age") or "").strip(),
                    traffic=(row.get("Traffic") or "0").strip() or "0",
                    bidders=(row.get("Bidders") or "0").strip() or "0",
                    min_bid=(row.get("Minimum Bid") or "").strip(),
                    close_et=dt.isoformat(),
                    close_display=dt.strftime("%-I:%M %p ET"),
                )
            )
    results.sort(key=lambda r: r.close_et)
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", type=Path, help="Path to DomainList CSV from NameJet")
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of bullets")
    args = parser.parse_args()

    rows = parse_rows(args.csv_path)
    if args.json:
        print(json.dumps([asdict(r) for r in rows], indent=2))
        return

    if not rows:
        print("(no rows matched the single-word filter)")
        return

    for row in rows:
        print(
            f"• {row.domain} — closes {row.close_display} — min bid ${row.min_bid} | "
            f"{row.bidders} bidders | {row.age}"
        )


if __name__ == "__main__":
    main()
