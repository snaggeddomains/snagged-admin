"""Unit tests for sedo_net_new pure helpers."""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from marketplace_pipeline.sources import sedo_net_new as src


def _record(domain="table.com", tld="com", price="125", end="2026-05-29T10:00:00Z"):
    return {
        "0": domain,
        "2": domain,
        "4002": tld,
        "4000": price,
        "4001": "USD",
        "1400": end,
    }


def test_parse_results_accepts_clean_row():
    out = src.parse_results([_record()])
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["tld"] == "com"
    assert out[0]["price"] == 125.0
    assert out[0]["currency"] == "USD"
    assert out[0]["url"] == "https://sedo.com/search/details/?domain=table.com"


def test_parse_results_rejects_disallowed_via_filter():
    # "trash.xyz" is disallowed TLD per standard filter
    out = src.parse_results([_record(domain="trash.xyz", tld="xyz")])
    assert out == []


def test_parse_results_handles_missing_price():
    out = src.parse_results([_record(price="")])
    assert out[0]["price"] is None


@pytest.mark.parametrize("end_raw,should_parse", [
    ("2026-05-29T10:00:00Z", True),
    ("2026-05-29T10:00:00+00:00", True),
    ("2026-05-29 10:00:00", True),
    ("", False),
    ("not-a-date", False),
    (None, False),
])
def test_parse_end_handles_formats(end_raw, should_parse):
    dt = src._parse_end(end_raw)
    if should_parse:
        assert dt is not None
        assert dt.tzinfo == timezone.utc
    else:
        assert dt is None


def test_to_et_display_returns_dash_for_none():
    assert src._to_et_display(None) == "—"


def test_to_et_display_renders_eastern_time():
    dt = datetime(2026, 5, 28, 14, 30, tzinfo=timezone.utc)  # 2:30 PM UTC
    label = src._to_et_display(dt)
    # 14:30 UTC in May (EDT) = 10:30 AM ET
    assert "ET" in label
    assert "10:30 AM" in label


def test_format_price_returns_dash_when_none():
    assert src._format_price(None, "USD") == "—"


def test_format_price_integer_uses_no_decimal():
    assert src._format_price(150.0, "USD") == "USD 150"


def test_format_price_decimal_trims_trailing_zeros():
    assert src._format_price(150.50, "USD") == "USD 150.5"


def test_format_price_with_thousands_separator():
    assert src._format_price(1500, "USD") == "USD 1,500"


def test_parse_float_handles_dollar_signs_and_commas():
    assert src._parse_float("$1,500.50") == 1500.50
    assert src._parse_float("100") == 100.0
    assert src._parse_float("") is None
    assert src._parse_float(None) is None
    assert src._parse_float("nope") is None


def test_build_sheet_rows_sorts_price_desc_then_domain():
    listings = [
        {"domain": "low.com",  "tld": "com", "price": 50,
         "currency": "USD", "end_time_utc": "2026-05-29T10:00:00+00:00", "url": ""},
        {"domain": "high.com", "tld": "com", "price": 999,
         "currency": "USD", "end_time_utc": "2026-05-29T10:00:00+00:00", "url": ""},
        {"domain": "alpha.com","tld": "com", "price": None,
         "currency": "USD", "end_time_utc": None, "url": ""},
    ]
    out = src.build_sheet_rows(listings)
    domains = [r["Domain"] for r in out]
    assert domains == ["high.com", "low.com", "alpha.com"]
    assert set(out[0].keys()) == {"Domain", "Auction End (ET)", "Price", "Link"}


def test_build_slack_message_contains_expected_pieces():
    new_listings = [{
        "domain": "table.com",
        "tld": "com",
        "price": 125,
        "currency": "USD",
        "end_time_utc": "2026-05-29T14:00:00+00:00",
        "url": "https://sedo.com/...",
    }]
    msg = src.build_slack_message(
        new_listings=new_listings,
        total_filtered=100,
        sheet_url="https://sheet",
    )
    assert "Sedo net-new check" in msg
    assert "1 new names matched" in msg
    assert "100 current filtered names total" in msg
    assert "table.com" in msg
    assert "USD 125" in msg
    assert "https://sheet" in msg
