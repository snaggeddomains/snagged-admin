"""Unit tests for atom_wholesale pure helpers."""
from __future__ import annotations

from marketplace_pipeline.sources import atom_wholesale as src


# ---------- parse_price ----------

def test_parse_price_extracts_dollar_amount():
    assert src.parse_price("Buy now $1,250") == (1250.0, "$1,250")


def test_parse_price_handles_decimals():
    assert src.parse_price("List $99.99") == (99.99, "$99.99")


def test_parse_price_returns_none_when_no_match():
    assert src.parse_price("just notes here") is None
    assert src.parse_price("") is None


# ---------- parse_entries ----------

def test_parse_entries_picks_simple_entry():
    paragraphs = [
        "table.com",
        "$1,500",
        "View Details",
    ]
    entries = src.parse_entries(paragraphs)
    assert len(entries) == 1
    assert entries[0].domain == "table.com"
    assert entries[0].price_value == 1500.0
    assert entries[0].notes == ""


def test_parse_entries_captures_notes():
    paragraphs = [
        "ocean.com",
        "$5,000",
        "great brand name",
        "5 letters",
        "View Details",
    ]
    entries = src.parse_entries(paragraphs)
    assert len(entries) == 1
    assert entries[0].notes == "great brand name | 5 letters"


def test_parse_entries_skips_lines_without_dot():
    paragraphs = [
        "header section",   # no dot, skip
        "table.com",
        "$1,000",
        "View Details",
    ]
    entries = src.parse_entries(paragraphs)
    assert len(entries) == 1


def test_parse_entries_skips_when_price_missing():
    paragraphs = [
        "table.com",
        "no price here",   # would-be price line has no $
        "View Details",
    ]
    # parse_price returns None for "no price here" so we increment i past
    # the domain and try again from "no price here" (no dot, skipped).
    entries = src.parse_entries(paragraphs)
    assert entries == []


def test_parse_entries_handles_multiple_entries():
    paragraphs = [
        "first.com", "$100", "View Details",
        "second.io", "$500", "premium", "View Details",
        "third.ai", "$2,000", "View Details",
    ]
    entries = src.parse_entries(paragraphs)
    assert [e.domain for e in entries] == ["first.com", "second.io", "third.ai"]
    assert entries[1].notes == "premium"


def test_parse_entries_lowercases_domain():
    paragraphs = ["Table.COM", "$100", "View Details"]
    assert src.parse_entries(paragraphs)[0].domain == "table.com"


def test_parse_entries_skips_unterminated_entry():
    """An entry without 'View Details' at the end is skipped."""
    paragraphs = ["table.com", "$100", "missing terminator"]
    assert src.parse_entries(paragraphs) == []


# ---------- scoring ----------

def test_brandability_increases_with_short_length():
    """Shorter SLD => bigger length bonus."""
    short = src.brandability(zipf=5.0, length=3, tld_weight=1.0)
    long  = src.brandability(zipf=5.0, length=12, tld_weight=1.0)
    assert short > long


def test_brandability_caps_zipf_component():
    """zipf > 4 should hit the cap quickly; very high zipf doesn't dominate."""
    v_med  = src.brandability(zipf=4.0, length=5, tld_weight=1.0)
    v_high = src.brandability(zipf=7.5, length=5, tld_weight=1.0)  # zipf component caps at 50
    # Difference should be small relative to the magnitude of v_med
    assert (v_high - v_med) < 20


def test_deal_score_zero_when_price_zero():
    assert src.deal_score(5.0, 0.0, 1.0) == 0.0


def test_deal_score_basic_math():
    # zipf=5, weight=1.0, price=100 => 5*1/100 * 10000 = 500
    assert src.deal_score(5.0, 100.0, 1.0) == 500.0


# ---------- row_for_sheet ----------

def test_row_for_sheet_columns_match_header():
    e = src.Entry(
        domain="table.com",
        price_value=1500.0,
        price_text="$1,500",
        notes="great",
        page=1,
        row_on_page=1,
        raw_text="table.com | great | $1,500 | View Details",
    )
    row = src.row_for_sheet(e, "2026-05-28")
    assert set(row.keys()) == set(src.SHEET_HEADER)
    assert row["source"] == "Atom Wholesale"
    assert row["currency"] == "USD"
    assert row["price"] == "$1,500.00"
    assert row["sld"] == "Table"
    assert row["tld"] == "com"


# ---------- Slack message ----------

def test_build_slack_message_renders_entries():
    e = src.Entry(
        domain="table.com",
        price_value=1500.0,
        price_text="$1,500",
        notes="",
        page=1,
        row_on_page=1,
        raw_text="",
    )
    msg = src.build_slack_message(entries=[e], appended=1, sheet_url="https://sheet")
    assert "table.com" in msg
    assert "$1,500" in msg
    assert "atom.com/ws/name/Table.com" in msg
    assert "Full sheet: <https://sheet|sheet>" in msg
    assert "1 new rows appended" in msg


# ---------- is_qualified ----------

def test_is_qualified_accepts_common_word_com():
    e = src.Entry(
        domain="table.com", price_value=100, price_text="", notes="",
        page=1, row_on_page=1, raw_text="",
    )
    assert src.is_qualified(e) is True


def test_is_qualified_rejects_unknown_tld():
    e = src.Entry(
        domain="table.xyz", price_value=100, price_text="", notes="",
        page=1, row_on_page=1, raw_text="",
    )
    # .xyz not in TLD_WEIGHTS table — gets default 0.2 — but rejected
    # because the daily-SNAP filter rejects .xyz at allow_domain step too
    assert src.is_qualified(e) is False


def test_is_qualified_rejects_nonsense():
    e = src.Entry(
        domain="qzqzqzq.com", price_value=100, price_text="", notes="",
        page=1, row_on_page=1, raw_text="",
    )
    assert src.is_qualified(e) is False
