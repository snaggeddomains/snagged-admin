"""Unit tests for the Atom daily source's pure helpers."""
from __future__ import annotations

from marketplace_pipeline.sources import atom_daily as src


def test_parse_csv_rows_basic():
    rows = src.parse_csv_rows(b"title,price\ntable.com,500\n")
    assert rows == [{"title": "table.com", "price": "500"}]


def test_entry_from_row_uses_title_column():
    e = src.entry_from_row({"title": "table.com", "price": "500"})
    assert e is not None
    assert e.domain == "table.com"


def test_entry_from_row_falls_back_to_domain_column():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    assert e is not None
    assert e.domain == "table.com"


def test_entry_from_row_uses_discount_price_fallback():
    e = src.entry_from_row({"title": "table.com", "discount_price": "500"})
    assert e is not None
    assert e.price == 500.0


def test_entry_from_row_rejects_below_min_price():
    assert src.entry_from_row({"title": "table.com", "price": "50"}) is None


def test_entry_from_row_rejects_zero_weight_tld():
    assert src.entry_from_row({"title": "table.xyz", "price": "500"}) is None


def test_atom_deal_score_is_unscaled():
    """Atom's deal score is intentionally NOT multiplied by 10000 — legacy parity."""
    # zipf=5, weight=1.0, price=100 -> 5/100*1 = 0.05 (not 500)
    assert src._atom_deal_score(5.0, 100.0, 1.0) == 0.05


def test_atom_deal_score_zero_when_non_positive_price():
    assert src._atom_deal_score(5.0, 0.0, 1.0) == 0.0


def test_computer_tld_is_allowed():
    assert src._tld_weight(".computer") == 0.3


def test_atom_link_uses_atom_url_when_no_override():
    e = src.entry_from_row({"title": "table.com", "price": "500"})
    assert e.link == "https://www.atom.com/name/table"


def test_atom_link_uses_provided_link_when_present():
    e = src.entry_from_row({"title": "table.com", "price": "500", "link": "https://elsewhere"})
    assert e.link == "https://elsewhere"


def test_diff_against_previous_classifies_new_dropped_priced():
    e_new = src.entry_from_row({"title": "table.com", "price": "500"})
    e_kept_changed = src.entry_from_row({"title": "ocean.com", "price": "999"})
    diff = src.diff_against_previous(
        [e_new, e_kept_changed],
        [{"domain": "ocean.com", "price": 1000}, {"domain": "river.com", "price": 500}],
    )
    assert {e.domain for e in diff["new_entries"]} == {"table.com"}
    assert set(diff["dropped_domains"]) == {"river.com"}
    assert len(diff["price_changes"]) == 1


def test_to_diff_row_columns_match_header():
    e = src.entry_from_row({"title": "table.com", "price": "500"})
    row = e.to_diff_row("2026-05-28", "2026-05-27")
    assert set(row.keys()) == set(src.DIFF_HEADER)
    assert row["source"] == "Atom"
    assert row["tld"] == "com"


def test_to_running_row_columns_match_header():
    e = src.entry_from_row({"title": "table.com", "price": "500"})
    row = e.to_running_row("2026-05-28")
    assert set(row.keys()) == set(src.RUNNING_HEADER)
    assert row["fast_transfer"] == "NO"


def test_build_slack_message_includes_top_entries():
    e = src.entry_from_row({"title": "table.com", "price": "500"})
    msg = src.build_slack_message(
        new_entries=[e],
        report_date="2026-05-28",
        sheet_url="https://sheet",
    )
    assert "Atom diff for 2026-05-28" in msg
    assert "table.com" in msg
    assert "https://sheet" in msg
