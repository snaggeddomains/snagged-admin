"""Unit tests for sedo_expired_auctions pure helpers."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from marketplace_pipeline.sources import sedo_expired_auctions as src


def test_parse_csv_rows_basic():
    csv = b"Domain Ace,Auction End Date,Current Bid\ntable.com,2026-05-29T10:00:00Z,150\n"
    rows = src.parse_csv_rows(csv)
    assert rows[0]["Domain Ace"] == "table.com"


@pytest.mark.parametrize("raw,expected_iso", [
    ("2026-05-29T10:00:00Z", "2026-05-29T10:00:00+00:00"),
    ("2026-05-29T10:00:00+00:00", "2026-05-29T10:00:00+00:00"),
    ("2026-05-29 10:00:00", "2026-05-29T10:00:00+00:00"),
])
def test_parse_end_time_handles_common_formats(raw, expected_iso):
    dt = src._parse_end_time(raw)
    assert dt is not None
    assert dt.isoformat() == expected_iso


def test_parse_end_time_returns_none_for_garbage():
    assert src._parse_end_time(None) is None
    assert src._parse_end_time("") is None
    assert src._parse_end_time("not-a-date") is None


def test_parse_auctions_accepts_clean_row():
    rows = [{
        "Domain Ace": "table.com",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "150",
        "Bids Count": "3",
        "Currency": "EUR",
    }]
    out = src.parse_auctions(rows)
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["price"] == 150.0
    assert out[0]["bid_count"] == 3
    assert out[0]["currency"] == "EUR"
    assert out[0]["platform"] == "Sedo Expired"
    assert out[0]["link"] == "https://sedo.com/search/details/?domain=table.com"


def test_parse_auctions_rejects_disallowed_tld():
    rows = [{
        "Domain Ace": "anything.xyz",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "150",
    }]
    assert src.parse_auctions(rows) == []


def test_parse_auctions_rejects_too_long_sld():
    long_word = "a" * 13
    rows = [{
        "Domain Ace": f"{long_word}.com",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "150",
    }]
    assert src.parse_auctions(rows) == []


def test_parse_auctions_rejects_unparsable_end_time():
    rows = [{
        "Domain Ace": "table.com",
        "Auction End Date": "garbage",
        "Current Bid": "150",
    }]
    assert src.parse_auctions(rows) == []


def test_parse_auctions_falls_back_to_idn_domain_column():
    rows = [{
        "Domain Ace": "",
        "Domain Idn": "ocean.com",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "200",
    }]
    out = src.parse_auctions(rows)
    assert out[0]["domain"] == "ocean.com"


def test_parse_auctions_handles_missing_price_and_bids():
    rows = [{
        "Domain Ace": "table.com",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "",
        "Bids Count": "",
    }]
    out = src.parse_auctions(rows)
    assert out[0]["price"] is None
    assert out[0]["bid_count"] is None


def test_parse_auctions_defaults_currency_to_eur():
    rows = [{
        "Domain Ace": "table.com",
        "Auction End Date": "2026-05-29T10:00:00Z",
        "Current Bid": "100",
    }]
    out = src.parse_auctions(rows)
    assert out[0]["currency"] == "EUR"


def test_parse_auctions_sorts_by_end_time_then_price_desc():
    rows = [
        {"Domain Ace": "later.com",  "Auction End Date": "2026-05-30T10:00:00Z", "Current Bid": "999"},
        {"Domain Ace": "early.com",  "Auction End Date": "2026-05-29T10:00:00Z", "Current Bid": "100"},
        {"Domain Ace": "ocean.com",  "Auction End Date": "2026-05-29T10:00:00Z", "Current Bid": "999"},
    ]
    domains = [x["domain"] for x in src.parse_auctions(rows)]
    # Earlier end first; within tie, higher price first
    assert domains == ["ocean.com", "early.com", "later.com"]


def test_parse_float_handles_commas_and_whitespace():
    assert src._parse_float("1,500.50") == 1500.50
    assert src._parse_float("  100 ") == 100.0
    assert src._parse_float("") is None
    assert src._parse_float(None) is None
    assert src._parse_float("not-a-number") is None
