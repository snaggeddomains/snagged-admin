"""Unit tests for namecheap_auctions pure helpers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import namecheap_auctions as src


@pytest.fixture
def now():
    return datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)


def _row(domain="table.com", end_offset_hours=24, price="100", bids="3", url=""):
    base = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = base + timedelta(hours=end_offset_hours)
    return {
        "name": domain,
        "endDate": end.isoformat(),
        "price": price,
        "bidCount": bids,
        "url": url,
    }


def test_parse_csv_rows_handles_bom():
    csv = b"\xef\xbb\xbfname,endDate,price\ntable.com,2026-05-29T04:00:00Z,250\n"
    rows = src.parse_csv_rows(csv)
    assert rows[0]["name"] == "table.com"


def test_parse_auctions_filters_horizon(now):
    rows = [
        _row("table.com", end_offset_hours=24),       # in window
        _row("future.com", end_offset_hours=130),      # beyond 120h
    ]
    out = src.parse_auctions(rows, now=now)
    domains = [x["domain"] for x in out]
    assert "table.com" in domains
    assert "future.com" not in domains


def test_parse_auctions_rejects_past_end_dates(now):
    rows = [_row("past.com", end_offset_hours=-1)]
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_rejects_disallowed_tld(now):
    rows = [_row("trash.xyz", end_offset_hours=24)]
    assert src.parse_auctions(rows, now=now) == []


def test_parse_auctions_handles_invalid_price_as_zero_then_none(now):
    rows = [_row(price="not-a-number")]
    out = src.parse_auctions(rows, now=now)
    assert out[0]["price"] is None


def test_parse_auctions_keeps_positive_price(now):
    rows = [_row(price="125.50")]
    out = src.parse_auctions(rows, now=now)
    assert out[0]["price"] == 125.50


def test_parse_auctions_falls_back_to_start_price(now):
    base_end = (datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc) + timedelta(hours=24)).isoformat()
    rows = [{
        "name": "table.com",
        "endDate": base_end,
        "price": "",
        "startPrice": "999",
        "bidCount": "0",
    }]
    out = src.parse_auctions(rows, now=now)
    assert out[0]["price"] == 999.0


def test_parse_auctions_sorts_by_end_time_then_bids(now):
    rows = [
        _row("late.com",   end_offset_hours=72, bids="1"),
        _row("river.com",  end_offset_hours=24, bids="2"),
        _row("ocean.com",  end_offset_hours=24, bids="10"),  # more bids first within tie
    ]
    out = src.parse_auctions(rows, now=now)
    domains = [x["domain"] for x in out]
    assert domains == ["ocean.com", "river.com", "late.com"]


def test_parse_auctions_normalizes_to_lowercase(now):
    rows = [_row("Table.COM")]
    out = src.parse_auctions(rows, now=now)
    assert out[0]["domain"] == "table.com"


def test_parse_auctions_returns_link_when_url_present(now):
    rows = [_row(url="https://www.namecheap.com/...")]
    out = src.parse_auctions(rows, now=now)
    assert out[0]["link"] == "https://www.namecheap.com/..."


def test_parse_dt_returns_none_for_garbage():
    assert src._parse_dt(None) is None
    assert src._parse_dt("") is None
    assert src._parse_dt("not-a-date") is None
