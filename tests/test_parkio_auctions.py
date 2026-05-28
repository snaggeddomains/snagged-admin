"""Unit tests for parkio_auctions pure helpers.

The Park.io close_date format is parsed via fixed character positions
(legacy parity) — we don't test that directly here because the exact
format is opaque. The first manual workflow run validates it end-to-end
against the real feed. These tests cover the higher-level filtering
logic by injecting pre-parsed datetimes via a stubbed _parse_close_date.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import parkio_auctions as src


@pytest.fixture
def now():
    return datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def fake_parse(monkeypatch):
    """Stub _parse_close_date so tests don't depend on the opaque date format.
    The 'close_date' field of each test row is treated as a number-of-hours
    offset from now; non-numeric values return None."""
    base = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)

    def fake(raw):
        if raw is None:
            return None
        try:
            offset_hours = float(raw)
        except (TypeError, ValueError):
            return None
        return base + timedelta(hours=offset_hours)

    monkeypatch.setattr(src, "_parse_close_date", fake)
    return base


def test_parse_auctions_filters_by_horizon(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "table.com", "close_date": "24", "price": 100},
            # Way past the 7-day (168-hour) horizon
            {"name": "future.com", "close_date": "200", "price": 100},
        ],
    }
    out = src.parse_auctions(payload, now=now)
    domains = [x["domain"] for x in out]
    assert "table.com" in domains
    assert "future.com" not in domains


def test_parse_auctions_rejects_past_close_dates(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "table.com", "close_date": "-1", "price": 100},
        ],
    }
    assert src.parse_auctions(payload, now=now) == []


def test_parse_auctions_filters_by_allow_domain(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "table.com", "close_date": "24", "price": 100},
            {"name": "anything.xyz", "close_date": "24", "price": 100},
        ],
    }
    domains = [x["domain"] for x in src.parse_auctions(payload, now=now)]
    assert "table.com" in domains
    assert "anything.xyz" not in domains


def test_parse_auctions_normalizes_domain_lowercase(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "Table.COM", "close_date": "24", "price": 100},
        ],
    }
    out = src.parse_auctions(payload, now=now)
    assert out[0]["domain"] == "table.com"


def test_parse_auctions_handles_missing_price(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "table.com", "close_date": "24", "price": None},
        ],
    }
    out = src.parse_auctions(payload, now=now)
    assert out[0]["price"] is None


def test_parse_auctions_sorts_by_end_time(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "later.com", "close_date": "72", "price": 1},
            {"name": "sooner.com", "close_date": "24", "price": 1},
        ],
    }
    out = src.parse_auctions(payload, now=now)
    assert out[0]["domain"] == "sooner.com"
    assert out[1]["domain"] == "later.com"


def test_parse_auctions_skips_unparsable_close_date(now, fake_parse):
    payload = {
        "auctions": [
            {"name": "table.com", "close_date": None, "price": 1},
            {"name": "table.com", "close_date": "garbage", "price": 1},
        ],
    }
    assert src.parse_auctions(payload, now=now) == []


def test_parse_close_date_returns_none_for_too_short_input():
    assert src._parse_close_date(None) is None
    assert src._parse_close_date("") is None
    assert src._parse_close_date("short") is None
