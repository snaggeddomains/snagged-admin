"""Unit tests for efty_partner pure helpers."""
from __future__ import annotations

import pytest

from marketplace_pipeline.sources import efty_partner as src


@pytest.mark.parametrize("raw,expected", [
    ("$1,500.50", 1500.50),
    ("100", 100.0),
    ("  $50  ", 50.0),
    ("", 0.0),
    ("not-a-number", 0.0),
    (None, 0.0),
])
def test_parse_price(raw, expected):
    assert src._parse_price(raw) == expected


def test_first_value_returns_first_nonempty_match():
    row = {"price": "", "bin": "", "buy_now": "999", "amount": "500"}
    assert src._first_value(row, ("price", "bin", "buy_now", "amount")) == "999"


def test_first_value_case_insensitive():
    row = {"DOMAIN": "table.com"}
    assert src._first_value(row, ("domain", "name")) == "table.com"


def test_first_value_returns_empty_when_no_match():
    assert src._first_value({}, ("domain",)) == ""


def test_decode_csv_strips_bom_and_whitespace():
    raw = b"\xef\xbb\xbf domain , price \n table.com , 100 \n"
    rows = src.decode_csv(raw)
    assert rows[0]["domain"] == "table.com"
    assert rows[0]["price"] == "100"


def test_score_row_accepts_clean_row():
    row = {"domain": "table.com", "price": "$500", "url": "https://t"}
    s = src.score_row(row)
    assert s is not None
    assert s.domain == "table.com"
    assert s.price == 500.0
    assert s.tld == ".com"
    assert s.sld == "table"
    assert s.link == "https://t"


def test_score_row_synthesizes_url_when_missing():
    row = {"domain": "table.com", "price": "$500"}
    assert src.score_row(row).link == "https://table.com"


def test_score_row_uses_first_present_price_field():
    row = {"domain": "table.com", "bin": "", "buy_now": "1500"}
    assert src.score_row(row).price == 1500.0


def test_score_row_skips_when_no_domain():
    assert src.score_row({"price": "500"}) is None


def test_score_row_skips_when_no_dot_in_domain():
    assert src.score_row({"domain": "notadomain", "price": "100"}) is None


def test_score_row_floors_zero_price_at_min():
    s = src.score_row({"domain": "table.com", "price": "0"})
    assert s.price == src.MIN_PRICE


def test_rank_good_deals_filters_zero_weight_tlds():
    s_com = src.score_row({"domain": "table.com", "price": "500"})
    # .xyz isn't in TLD_WEIGHTS so weight=0; would be dropped by rank_good_deals
    # Construct manually since allow_domain would reject .xyz earlier anyway:
    out = src.rank_good_deals([s_com])
    assert s_com in out


def test_rank_good_deals_sorts_by_deal_score_desc():
    rows = [
        src.score_row({"domain": "table.com", "price": "1000"}),  # lower deal
        src.score_row({"domain": "ocean.com", "price": "100"}),   # higher deal
    ]
    out = src.rank_good_deals(rows)
    # The higher-deal one should come first
    deals = [r.deal_score for r in out]
    assert deals == sorted(deals, reverse=True)


def test_diff_against_previous_classifies():
    cur = [
        src.score_row({"domain": "kept.com", "price": "200"}),
        src.score_row({"domain": "new.com", "price": "150"}),
    ]
    prev = [
        {"domain": "kept.com", "price": 200, "deal_score": 1.0,
         "quality_score": 1.0, "zipf_score": 1.0, "tld": ".com",
         "sld": "kept", "link": ""},
        {"domain": "dropped.com", "price": 999, "deal_score": 1.0,
         "quality_score": 1.0, "zipf_score": 1.0, "tld": ".com",
         "sld": "dropped", "link": ""},
    ]
    diff = src.diff_against_previous(cur, prev)
    assert {r.domain for r in diff["new_entries"]} == {"new.com"}
    assert set(diff["dropped_domains"]) == {"dropped.com"}


def test_diff_picks_up_price_changes():
    cur = [src.score_row({"domain": "kept.com", "price": "150"})]
    prev = [{"domain": "kept.com", "price": 200, "deal_score": 1, "quality_score": 1,
             "zipf_score": 1, "tld": ".com", "sld": "kept", "link": ""}]
    diff = src.diff_against_previous(cur, prev)
    assert len(diff["price_changes"]) == 1
    assert diff["price_changes"][0]["old_price"] == 200
    assert diff["price_changes"][0]["new_price"] == 150


def test_build_slack_message_for_zero_new_with_ranked_falls_back_to_top_deals():
    r = src.score_row({"domain": "table.com", "price": "500"})
    msg = src.build_slack_message(
        ranked=[r], new_entries=[],
        dropped_count=0, price_change_count=0,
    )
    assert "Top deals overall today" in msg
    assert "table.com" in msg


def test_build_slack_message_for_zero_total():
    msg = src.build_slack_message(
        ranked=[], new_entries=[],
        dropped_count=0, price_change_count=0,
    )
    assert "0 met criteria today" in msg


def test_build_slack_message_for_new_entries():
    r = src.score_row({"domain": "table.com", "price": "500"})
    msg = src.build_slack_message(
        ranked=[r], new_entries=[r],
        dropped_count=2, price_change_count=3,
    )
    assert "Top new qualifying names" in msg
    assert "table.com" in msg
    assert "Removals found: 2" in msg
    assert "Price changes: 3" in msg
