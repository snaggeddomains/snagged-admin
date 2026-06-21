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


def test_parse_auctions_keeps_low_freq_word_with_market_signal(now):
    # 'sniffle' is below the SNAP word cutoff (zipf 2.21) but 52 bids => market override.
    out = src.parse_auctions([_row(domain="sniffle.com", bids=52, price="$6,100")], now=now)
    assert [r["domain"] for r in out] == ["sniffle.com"]


def test_parse_auctions_market_override_on_valuation(now):
    row = _row(domain="sniffle.com", bids=0, price="$5")
    row["valuation"] = "$11,033"
    out = src.parse_auctions([row], now=now)
    assert [r["domain"] for r in out] == ["sniffle.com"]


def test_parse_auctions_market_override_needs_signal(now):
    # Same low-freq word, no demand/value => still filtered out.
    out = src.parse_auctions([_row(domain="sniffle.com", bids=0, price="$5")], now=now)
    assert out == []


def test_parse_auctions_market_override_keeps_shape_gate(now):
    # A hyphenated name can't ride in on bids.
    out = src.parse_auctions([_row(domain="anti-spiritual.com", bids=99, price="$9,000")], now=now)
    assert out == []


def test_parse_auctions_market_override_rejects_multiword(now):
    # Long multi-word compounds (zipf 0, not short) don't ride in on bids.
    for d in ("worldweathernetwork.org", "marketingresults.com", "friscoobgyn.com"):
        assert src.parse_auctions([_row(domain=d, bids=99, price="$9,000")], now=now) == [], d


def test_parse_auctions_market_override_keeps_short_brandable(now):
    out = src.parse_auctions([_row(domain="bullz.com", bids=20, price="$2,000")], now=now)
    assert [r["domain"] for r in out] == ["bullz.com"]


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
