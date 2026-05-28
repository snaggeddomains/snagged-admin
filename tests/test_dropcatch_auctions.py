"""Unit tests for dropcatch_auctions pure helpers.

The Playwright fetch is exercised end-to-end via the manual workflow
trigger; here we cover parse_time_left and parse_auctions against
synthetic HTML.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import dropcatch_auctions as src


# ---------- parse_time_left ----------

@pytest.mark.parametrize("text,expected_seconds", [
    ("2d 3h",          (2 * 86400) + (3 * 3600)),
    ("4h 12m",         (4 * 3600) + (12 * 60)),
    ("30m",            30 * 60),
    ("1d",             86400),
    ("3h",             3 * 3600),
])
def test_parse_time_left_handles_combinations(text, expected_seconds):
    delta = src.parse_time_left(text)
    assert delta is not None
    assert delta.total_seconds() == expected_seconds


def test_parse_time_left_zero_returns_none():
    assert src.parse_time_left("0d 0h 0m") is None


def test_parse_time_left_empty_returns_none():
    assert src.parse_time_left("") is None
    assert src.parse_time_left("nope") is None


# ---------- parse_auctions ----------

def _card(domain: str, time_left: str, price: str = "", bids: str = "", href: str = "") -> str:
    return (
        f'<section class="dc-table__list-item">'
        f'  <a class="domain-item" href="{href}">{domain}</a>'
        f'  <time id="time-remaining">{time_left}</time>'
        f'  <span id="domainPrice">{price}</span>'
        f'  <span id="bidCount">{bids}</span>'
        f'</section>'
    )


def _now():
    return datetime(2026, 5, 28, 12, 0, tzinfo=src.EASTERN)


def test_parse_auctions_picks_up_clean_card():
    html = "<html><body>" + _card("table.com", "2d 3h", "$120", "5", "/auctions/table.com") + "</body></html>"
    out = src.parse_auctions(html, now=_now())
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["price"] == 120.0
    assert out[0]["bid_count"] == 5
    assert out[0]["link"] == "https://www.dropcatch.com/auctions/table.com"
    assert out[0]["platform"] == "DropCatch"


def test_parse_auctions_skips_disallowed_tld():
    html = "<html><body>" + _card("trash.xyz", "2d 3h", "$10") + "</body></html>"
    assert src.parse_auctions(html, now=_now()) == []


def test_parse_auctions_skips_when_time_unparseable():
    html = "<html><body>" + _card("table.com", "tba", "$10") + "</body></html>"
    assert src.parse_auctions(html, now=_now()) == []


def test_parse_auctions_skips_beyond_horizon():
    # 8d > 7d horizon
    html = "<html><body>" + _card("table.com", "8d 0h", "$10") + "</body></html>"
    assert src.parse_auctions(html, now=_now()) == []


def test_parse_auctions_lowercases_domain():
    html = "<html><body>" + _card("Table.COM", "2d 0h", "$50") + "</body></html>"
    out = src.parse_auctions(html, now=_now())
    assert out[0]["domain"] == "table.com"


def test_parse_auctions_handles_missing_price_and_bids():
    html = "<html><body>" + _card("table.com", "2d 0h") + "</body></html>"
    out = src.parse_auctions(html, now=_now())
    assert out[0]["price"] is None
    assert out[0]["bid_count"] is None


def test_parse_auctions_sorts_by_end_time():
    html = (
        "<html><body>"
        + _card("later.com", "5d 0h", "$10")
        + _card("sooner.com", "1d 0h", "$10")
        + "</body></html>"
    )
    domains = [x["domain"] for x in src.parse_auctions(html, now=_now())]
    assert domains == ["sooner.com", "later.com"]


def test_parse_auctions_returns_empty_for_empty_html():
    assert src.parse_auctions("<html></html>", now=_now()) == []
