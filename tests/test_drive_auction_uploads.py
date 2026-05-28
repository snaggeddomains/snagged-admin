"""Unit tests for drive_auction_uploads pure helpers.

The Drive listing + download is exercised by the manual workflow run
against the real folder; here we cover parsing + dedup + filtering.
"""
from __future__ import annotations

import io
import pytest

from marketplace_pipeline.sources import drive_auction_uploads as src


@pytest.mark.parametrize("domain,expected", [
    ("table.com", True),
    ("ocean.org", True),
    ("river.io", True),
    ("hello.co", True),
    ("trash.xyz", False),       # disallowed TLD
    ("foo.app", False),         # disallowed TLD
    ("bar123.com", False),      # digit in SLD
    ("foo-bar.com", False),     # hyphen in SLD
    ("a" * 16 + ".com", False), # SLD too long
    ("", False),
])
def test_upload_filter_basic_cases(domain, expected):
    assert src.upload_filter(domain) is expected


@pytest.mark.parametrize("raw,expected", [
    ("$1,500.50", 1500.50),
    ("$100", 100.0),
    ("100", 100.0),
    ("  ", None),
    (None, None),
    ("nope", None),
])
def test_parse_money(raw, expected):
    assert src._parse_money(raw) == expected


def test_parse_dt_returns_utc_for_iso():
    dt = src._parse_dt("2026-05-29T10:00:00")
    assert dt is not None
    assert dt.tzinfo is not None


def test_parse_dt_returns_none_for_available_marker():
    assert src._parse_dt("Available") is None
    assert src._parse_dt("Available Soon") is None


def test_parse_dt_returns_none_for_garbage():
    assert src._parse_dt(None) is None
    assert src._parse_dt("") is None
    assert src._parse_dt("not-a-date") is None


def test_parse_dt_treats_input_as_eastern_then_converts():
    """A naive 'Jan 1 10:00 AM' string should be parsed as Eastern and
    converted to UTC (so 10am ET == 14:00 or 15:00 UTC depending on DST)."""
    dt = src._parse_dt("Jan 1, 2026 10:00 AM")
    assert dt is not None
    # EDT/EST = UTC-4 or UTC-5; January is EST so 10am ET = 15:00 UTC.
    # We model the source as EDT (UTC-4) per legacy parity, so 10am -> 14:00 UTC.
    assert dt.hour in (14, 15)


def test_normalize_headers_strips_whitespace_and_nulls():
    assert src._normalize_headers([" Domain ", None, "Price"]) == ["Domain", "", "Price"]


def test_find_col_case_insensitive():
    headers = ["Domain Name", "Price", "End Time"]
    assert src._find_col(headers, ("domain name", "domain")) == "Domain Name"
    assert src._find_col(headers, ("nonexistent",)) is None


def test_rows_from_csv_strips_bom():
    raw = b"\xef\xbb\xbfDomain,Price\ntable.com,100\n"
    headers, rows = src._rows_from_csv(raw)
    assert headers == ["Domain", "Price"]
    assert rows[0]["Domain"] == "table.com"


def test_parse_generic_picks_up_domain_and_price_via_fallbacks():
    meta = {"name": "upload.csv", "id": "f1", "modifiedTime": "2026-05-28T00:00:00Z"}
    headers = ["Name", "BIN", "End Date"]
    rows = [{"Name": "table.com", "BIN": "$150", "End Date": "2026-05-29 10:00:00"}]
    out = src._parse_generic(rows, headers, meta)
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["price"] == 150.0


def test_parse_generic_returns_empty_when_no_domain_column():
    meta = {"name": "x.csv", "id": "f2"}
    headers = ["A", "B"]
    rows = [{"A": "x", "B": "y"}]
    assert src._parse_generic(rows, headers, meta) == []


def test_parse_namejet_like_uses_namejet_link():
    meta = {"name": "lastchance.csv", "id": "f3", "modifiedTime": "2026-05-28T00:00:00Z"}
    rows = [{
        "Domain Name": "table.com",
        "Order By": "2026-05-29 10:00:00",
        "Minimum Bid": "75",
        "Bidders": "3",
    }]
    out = src._parse_namejet_like(rows, meta)
    assert out[0]["link"] == "https://www.namejet.com/domain/table.com.action"
    assert out[0]["price"] == 75.0
    assert out[0]["bid_count"] == 3
    assert out[0]["platform"] == "NameJet Upload"


def test_detect_and_parse_dispatches_to_namejet_when_headers_match():
    """A CSV with 'Domain Name' + 'Order By' headers should use the
    NameJet parser even though it's just a CSV."""
    raw = b"Domain Name,Order By,Minimum Bid,Bidders\ntable.com,2026-05-29 10:00:00,50,2\n"
    meta = {"name": "nj.csv", "id": "f4", "modifiedTime": "2026-05-28T00:00:00Z"}
    out = src.detect_and_parse(meta, raw)
    assert len(out) == 1
    assert out[0]["platform"] == "NameJet Upload"


def test_detect_and_parse_falls_back_to_generic():
    raw = b"Name,Price,End\ntable.com,150,2026-05-29 10:00:00\n"
    meta = {"name": "u.csv", "id": "f5", "modifiedTime": "2026-05-28T00:00:00Z"}
    out = src.detect_and_parse(meta, raw)
    assert out[0]["platform"] == "Drive Upload"


def test_detect_and_parse_skips_unknown_extensions():
    meta = {"name": "u.txt", "id": "f6", "modifiedTime": "2026-05-28T00:00:00Z"}
    assert src.detect_and_parse(meta, b"x") == []


def test_dedupe_listings_prefers_newer_source_file():
    older = {
        "domain": "table.com",
        "source_file_modified": "2026-05-28T00:00:00Z",
        "end_time_utc": "2026-05-29T10:00:00+00:00",
        "price": 100,
    }
    newer = {
        "domain": "table.com",
        "source_file_modified": "2026-05-29T00:00:00Z",
        "end_time_utc": "2026-05-29T10:00:00+00:00",
        "price": 200,
    }
    out = src.dedupe_listings([older, newer])
    assert len(out) == 1
    assert out[0]["price"] == 200


def test_dedupe_listings_prefers_priced_when_modified_ties():
    a = {
        "domain": "table.com",
        "source_file_modified": "2026-05-28T00:00:00Z",
        "end_time_utc": "2026-05-29T10:00:00+00:00",
        "price": None,
    }
    b = {
        "domain": "table.com",
        "source_file_modified": "2026-05-28T00:00:00Z",
        "end_time_utc": "2026-05-29T10:00:00+00:00",
        "price": 100,
    }
    out = src.dedupe_listings([a, b])
    assert out[0]["price"] == 100
