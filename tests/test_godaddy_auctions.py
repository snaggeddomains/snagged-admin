"""Unit tests for godaddy_auctions pure helpers."""
from __future__ import annotations

import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import godaddy_auctions as src


@pytest.fixture
def now():
    return datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)


def _make_zip(filename: str, payload: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(filename, json.dumps(payload))
    return buf.getvalue()


def _row(domain="table.com", end_offset_hours=24, price="$100", bids=3, link="https://gd"):
    base = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = base + timedelta(hours=end_offset_hours)
    return {
        "domainName": domain,
        "auctionEndTime": end.isoformat(),
        "price": price,
        "numberOfBids": bids,
        "link": link,
        "isAdult": False,
    }


def test_extract_rows_from_zip_returns_data_array():
    payload = {"data": [{"domainName": "a.com"}, {"domainName": "b.com"}]}
    z = _make_zip("auctions.json", payload)
    rows = src.extract_rows_from_zip(z)
    assert {r["domainName"] for r in rows} == {"a.com", "b.com"}


def test_extract_rows_from_zip_skips_non_json_members():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", "ignore")
        zf.writestr("auctions.json", json.dumps({"data": [{"domainName": "x.com"}]}))
    rows = src.extract_rows_from_zip(buf.getvalue())
    assert len(rows) == 1


def test_extract_rows_from_zip_handles_missing_data_key():
    z = _make_zip("a.json", {"meta": "no data array"})
    assert src.extract_rows_from_zip(z) == []


@pytest.mark.parametrize("raw,expected", [
    ("$1,500.50", 1500.50),
    ("$100", 100.0),
    ("100", 100.0),
    (1500, 1500.0),
    (1500.5, 1500.5),
    (None, None),
    ("", None),
    ("not-a-number", None),
])
def test_parse_price(raw, expected):
    assert src._parse_price(raw) == expected


def test_parse_auctions_accepts_clean_row(now):
    rows = [_row()]
    out = src.parse_auctions(rows, now=now)
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["price"] == 100.0
    assert out[0]["bid_count"] == 3
    assert out[0]["link"] == "https://gd"
    assert out[0]["platform"] == "GoDaddy"


def test_parse_auctions_skips_adult(now):
    rows = [{**_row(), "isAdult": True}]
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_skips_disallowed_tld(now):
    rows = [_row(domain="trash.xyz")]
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_skips_past_end_time(now):
    rows = [_row(end_offset_hours=-1)]
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_skips_beyond_horizon(now):
    rows = [_row(end_offset_hours=100)]  # beyond 48h
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_dedupes_overlapping_dumps(now):
    # Today+tomorrow zip may both include the same auction
    rows = [_row(domain="table.com"), _row(domain="table.com")]
    out = src.parse_auctions(rows, now=now)
    assert len(out) == 1


def test_parse_auctions_sorts_by_end_time(now):
    rows = [
        _row(domain="later.com", end_offset_hours=30),
        _row(domain="earlier.com", end_offset_hours=12),
    ]
    domains = [x["domain"] for x in src.parse_auctions(rows, now=now)]
    assert domains == ["earlier.com", "later.com"]


def test_parse_time_returns_none_for_garbage():
    assert src._parse_time(None) is None
    assert src._parse_time("") is None
    assert src._parse_time("garbage") is None


def test_parse_time_treats_naive_as_utc():
    dt = src._parse_time("2026-05-29T10:00:00")
    assert dt is not None
    assert dt.tzinfo == timezone.utc
