"""Fetch fresh Sedo marketplace results via the live search backend and store CSV snapshots."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import sys
from pathlib import Path
from typing import Iterable

import requests

BASE_URL = "https://sedo.com/service/common.php"
SEARCH_URL = "https://sedo.com/search/"
DEFAULT_SIZE = 500
DEFAULT_TLDS = ("com", "net", "ai", "co")
DEFAULT_MIN_LEN = 1
DEFAULT_MAX_LEN = 12
DEFAULT_MAX_WORDS = 2
DEFAULT_MAX_AGE = 24
OUTPUT_DIR = Path("data/sedo")
CSV_COLUMNS = [
    "Domain Ace",
    "Domain Idn",
    "Tld",
    "Bids Count",
    "Current Bid",
    "Currency",
    "Auction End Date",
    "Domain Length",
    "Domain Hyphens Count",
    "Domain Numbers Count",
    "Is Idn",
    "Majestic Backlinks",
    "Majestic Domain Pop",
    "Majestic TrustFlow",
    "Majestic CitationFlow",
    "Google Search Volume (global)",
    "Google CPC (global)",
    "Google CPC Currency",
    "Sedo Parking Views (31d)",
    "Domain Age",
]

FIELD_MAP = {
    "Domain Ace": "0",
    "Domain Idn": "2",
    "Tld": "4002",
    "Bids Count": "6",
    "Current Bid": "4000",
    "Currency": "4001",
    "Auction End Date": "1400",
    "Domain Length": "4004",
    "Domain Hyphens Count": "hyphensCount",
    "Domain Numbers Count": "digitsCount",
    "Is Idn": "4006",
    "Majestic Backlinks": "externalBacklinksCount",
    "Majestic Domain Pop": "referringDomainsCount",
    "Majestic TrustFlow": "trustFlow",
    "Majestic CitationFlow": "citationFlow",
    "Google Search Volume (global)": "searchVolume",
    "Google CPC (global)": "cpc",
    "Google CPC Currency": "cpcCurrency",
    "Sedo Parking Views (31d)": "views",
    "Domain Age": "1100",
}


def build_payload(
    tlds: Iterable[str],
    length_min: int,
    length_max: int,
    max_words: int,
    max_age: int,
    size: int,
    page: int,
) -> list[tuple[str, str | int]]:
    payload: list[tuple[str, str | int]] = [
        ("safe_search", 2),
        ("synonyms", "true"),
        ("listing_type[]", 1),
        ("listing_type[]", 2),
        ("listing_type[]", 3),
        ("listing_type[]", 5),
        ("auction_group[]", 62),
        ("auction_event", ""),
        ("price_start", 0),
        ("price_end", 0),
        ("price_currency", 3),
        ("traffic_start", 0),
        ("traffic_end", 0),
        ("number_of_words_min", 1),
        ("number_of_words_max", max_words),
        ("len_min", length_min),
        ("len_max", length_max if length_max > 0 else 0),
        ("special_characters[]", 3),
        ("special_characters[]", 1),
        ("special_characters[]", 2),
        ("cat[]", 0),
        ("cat[]", 0),
        ("cat[]", 0),
        ("type", 0),
        ("special_inventory", 4),
        ("kws", "contains"),
        ("age_min", 0),
        ("age_max", max_age),
        ("keyword", ""),
        ("page", page),
        ("rel", 6),
        ("orderdirection", 2),
        ("domainIds", ""),
    ]
    for tld in tlds:
        payload.append(("cc[]", tld))
    payload.extend(
        [
            ("member", ""),
            ("v", "0.1"),
            ("o", "json"),
            ("m", "search"),
            ("f", "requestSearch"),
            ("pagesize", size),
            ("keywords_join", "AND"),
            ("loadListingFeatured", "true"),
            ("language", "us"),
        ]
    )
    return payload


def fetch_page(
    session: requests.Session,
    tlds: list[str],
    length_min: int,
    length_max: int,
    max_words: int,
    max_age: int,
    size: int,
    page: int,
) -> list[dict]:
    referer = requests.Request("GET", SEARCH_URL, params={f"cc[{i}]": tld for i, tld in enumerate(tlds)}).prepare().url
    if max_words > 0:
        referer += f"&number_of_words_max={max_words}"
    if max_age > 0:
        referer += f"&age_max={max_age}"
    headers = {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://sedo.com",
        "referer": referer,
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36",
    }
    payload = build_payload(tlds, length_min, length_max, max_words, max_age, size, page)
    try:
        resp = session.post(BASE_URL, data=payload, headers=headers, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as exc:  # pragma: no cover
        raise SystemExit(f"Sedo search request failed: {exc}") from exc
    data = resp.json()
    try:
        return data["b"]["general"]["searchRequest"]["resultList"]
    except Exception as exc:  # pragma: no cover
        raise SystemExit(f"Unexpected Sedo response payload: {data}") from exc


def rows_to_csv(rows: list[dict], allowed_tlds: set[str]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for row in rows:
        tld = str(row.get("4002", "")).lower().lstrip('.')
        if allowed_tlds and tld not in allowed_tlds:
            continue
        writer.writerow([row.get(FIELD_MAP[col], "") for col in CSV_COLUMNS])
    return buf.getvalue()


def write_files(csv_text: str, timestamp: dt.datetime) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    latest_path = OUTPUT_DIR / "expiring_latest.csv"
    dated_path = OUTPUT_DIR / f"expiring_{timestamp:%Y-%m-%d}.csv"
    latest_path.write_text(csv_text, encoding="utf-8")
    dated_path.write_text(csv_text, encoding="utf-8")
    print(f"Wrote {latest_path} and {dated_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tlds", default=",".join(DEFAULT_TLDS), help="Comma-separated list of TLDs to include")
    parser.add_argument("--length-min", type=int, default=DEFAULT_MIN_LEN, dest="length_min", help="Minimum SLD length filter")
    parser.add_argument("--length-max", type=int, default=DEFAULT_MAX_LEN, dest="length_max", help="Maximum SLD length filter")
    parser.add_argument("--max-words", type=int, default=DEFAULT_MAX_WORDS, dest="max_words", help="Maximum word count filter")
    parser.add_argument("--max-age", type=int, default=DEFAULT_MAX_AGE, dest="max_age", help="Maximum age filter from Sedo search")
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE, help="Rows per page to request")
    args = parser.parse_args()

    tlds = [t.strip().lstrip(".") for t in args.tlds.split(",") if t.strip()]
    if not tlds:
        parser.error("At least one TLD must be provided")

    session = requests.Session()
    session.get(SEARCH_URL, timeout=30)

    records = fetch_page(
        session=session,
        tlds=tlds,
        length_min=args.length_min,
        length_max=args.length_max,
        max_words=args.max_words,
        max_age=args.max_age,
        size=args.size,
        page=1,
    )
    print(f"Fetched Sedo page 1 -> {len(records)} rows")

    if not records:
        print("No Sedo rows matched the filters", file=sys.stderr)
        return

    allowed_tlds = {t.lower().lstrip('.') for t in tlds}
    csv_blob = rows_to_csv(records, allowed_tlds)
    if csv_blob.strip().count("\n") <= 1:
        print("No Sedo rows remained after TLD filtering", file=sys.stderr)
        return

    write_files(csv_blob, dt.datetime.now(dt.timezone.utc))


if __name__ == "__main__":
    main()
