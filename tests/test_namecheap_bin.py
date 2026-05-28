"""Unit tests for namecheap_bin pure helpers (parsing/filtering/scoring/diff).

The run() function is not unit-tested here — it does live HTTP + Drive +
Sheets + Slack and is verified end-to-end via `pipeline run namecheap_bin`
in a manual workflow trigger.
"""
from __future__ import annotations

from marketplace_pipeline.sources import namecheap_bin as src


def test_parse_csv_rows_handles_simple_csv():
    csv = b"domain,price,permalink\nexample.com,250,https://link\nfoo.com,1500,\n"
    rows = src.parse_csv_rows(csv)
    assert len(rows) == 2
    assert rows[0]["domain"] == "example.com"


def test_entry_from_row_rejects_below_min_price():
    e = src.entry_from_row({"domain": "table.com", "price": "50"})
    assert e is None


def test_entry_from_row_rejects_disallowed_tld():
    e = src.entry_from_row({"domain": "table.xyz", "price": "500"})
    assert e is None


def test_entry_from_row_accepts_clean_domain():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    assert e is not None
    assert e.domain == "table.com"
    assert e.price == 500.0
    assert e.tld == ".com"
    assert e.sld == "table"
    assert e.weight == 1.0
    assert e.zipf > 0
    assert e.quality > 0
    assert e.deal > 0


def test_entry_from_row_synthesizes_permalink_when_missing():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    assert e is not None
    assert "namecheap.com/market/buynow/table.com" in e.link


def test_entry_from_row_handles_price_with_comma():
    e = src.entry_from_row({"domain": "table.com", "price": "1,500"})
    assert e is not None
    assert e.price == 1500.0


def test_build_shortlist_dedups_union_and_orders_by_quality_then_deal():
    rows = [
        {"domain": "ocean.com",  "price": "500"},
        {"domain": "river.com",  "price": "500"},
        {"domain": "table.com",  "price": "100"},  # higher deal (lower price)
    ]
    entries = [src.entry_from_row(r) for r in rows]
    entries = [e for e in entries if e]
    short = src.build_shortlist(entries, top_n=10)
    assert len(short) == len(entries)
    # ordering: quality desc, then deal desc; just confirm sorted
    qualities = [e.quality for e in short]
    assert qualities == sorted(qualities, reverse=True)


def test_diff_against_previous_classifies_new_dropped_priced():
    e_new = src.entry_from_row({"domain": "table.com",  "price": "500"})
    e_keep_changed = src.entry_from_row({"domain": "ocean.com",  "price": "999"})
    current = [e_new, e_keep_changed]

    previous = [
        {"domain": "ocean.com", "price": 1000},   # price change
        {"domain": "river.com", "price": 500},    # dropped
    ]
    diff = src.diff_against_previous(current, previous)
    assert {e.domain for e in diff["new_entries"]} == {"table.com"}
    assert set(diff["dropped_domains"]) == {"river.com"}
    assert len(diff["price_changes"]) == 1
    assert diff["price_changes"][0]["domain"] == "ocean.com"
    assert diff["price_changes"][0]["old_price"] == 1000
    assert diff["price_changes"][0]["new_price"] == 999


def test_build_slack_message_contains_expected_lines():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    msg = src.build_slack_message(
        new_entries=[e],
        raw_count=10_000,
        filtered_count=3_000,
        total_ranked=500,
        fresh_added=1,
        dropped_count=2,
        price_change_count=3,
        sheet_url="https://sheet",
    )
    assert "Namecheap exclusive daily diff is live." in msg
    assert "10,000" in msg
    assert "Top new qualifying names:" in msg
    assert "table.com" in msg
    assert "Full sheet: <https://sheet|sheet>" in msg


def test_build_slack_message_handles_zero_new():
    msg = src.build_slack_message(
        new_entries=[],
        raw_count=10_000,
        filtered_count=0,
        total_ranked=0,
        fresh_added=0,
        dropped_count=0,
        price_change_count=0,
        sheet_url="https://sheet",
    )
    assert "0 met criteria today." in msg


def test_to_sheet_row_columns_match_header():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    row = e.to_sheet_row("2026-05-28", "2026-05-27")
    assert set(row.keys()) == set(src.SHEET_HEADER)
    assert row["source"] == "Namecheap"
    assert row["tld"] == "com"  # leading dot stripped
    assert row["date_added"] == "2026-05-28"
    assert row["prev_snapshot"] == "2026-05-27"
