"""Unit tests for the Afternic source's pure helpers."""
from __future__ import annotations

import io
import zipfile

from marketplace_pipeline.sources import afternic as src


def _make_zip(filename: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(filename, content)
    return buf.getvalue()


def test_extract_csv_from_zip_finds_first_csv():
    payload = b"domain,price\nexample.com,250\n"
    z = _make_zip("inventory.csv", payload)
    assert src.extract_csv_from_zip(z) == payload


def test_extract_csv_ignores_non_csv_members():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("readme.txt", b"ignore me")
        zf.writestr("inv.csv", b"domain,price\nfoo.com,100\n")
    assert b"domain,price" in src.extract_csv_from_zip(buf.getvalue())


def test_parse_csv_rows_basic():
    rows = src.parse_csv_rows(b"domain,price,is-fast-transfer\ntable.com,500,1\n")
    assert rows == [{"domain": "table.com", "price": "500", "is-fast-transfer": "1"}]


def test_entry_from_row_accepts_clean_domain():
    e = src.entry_from_row({"domain": "table.com", "price": "500", "is-fast-transfer": "1"})
    assert e is not None
    assert e.domain == "table.com"
    assert e.fast_transfer is True
    assert e.weight == 1.0
    assert e.quality > 0
    assert e.deal > 0
    assert e.link.startswith("https://www.afternic.com/domain/")


def test_entry_from_row_rejects_below_min_price():
    assert src.entry_from_row({"domain": "table.com", "price": "50"}) is None


def test_entry_from_row_rejects_zero_weight_tld():
    assert src.entry_from_row({"domain": "table.xyz", "price": "500"}) is None


def test_entry_from_row_handles_fast_transfer_flag_variants():
    for raw, expected in [("1", True), ("yes", True), ("YES", True), ("true", True),
                          ("0", False), ("no", False), ("", False)]:
        e = src.entry_from_row({"domain": "table.com", "price": "500", "is-fast-transfer": raw})
        assert e is not None
        assert e.fast_transfer is expected, f"{raw!r} -> {expected}"


def test_computer_tld_is_allowed_for_afternic_specifically():
    """Afternic-specific TLD weight table includes .computer (legacy parity)."""
    assert src._tld_weight(".computer") == 0.3
    assert src._tld_weight("computer") == 0.3


def test_build_shortlist_dedups_union():
    rows = [
        {"domain": "ocean.com", "price": "500"},
        {"domain": "river.com", "price": "500"},
        {"domain": "table.com", "price": "100"},
    ]
    entries = [e for e in (src.entry_from_row(r) for r in rows) if e]
    short = src.build_shortlist(entries, top_n=10)
    assert len(short) == len(entries)
    qualities = [e.quality for e in short]
    assert qualities == sorted(qualities, reverse=True)


def test_diff_against_previous_classifies_correctly():
    e_new = src.entry_from_row({"domain": "table.com", "price": "500", "is-fast-transfer": "0"})
    e_kept_changed = src.entry_from_row({"domain": "ocean.com", "price": "999"})
    diff = src.diff_against_previous(
        [e_new, e_kept_changed],
        [{"domain": "ocean.com", "price": 1000}, {"domain": "river.com", "price": 500}],
    )
    assert {e.domain for e in diff["new_entries"]} == {"table.com"}
    assert set(diff["dropped_domains"]) == {"river.com"}
    assert len(diff["price_changes"]) == 1


def test_to_running_row_uses_yes_no_for_fast_transfer():
    e = src.entry_from_row({"domain": "table.com", "price": "500", "is-fast-transfer": "1"})
    row = e.to_running_row("2026-05-28")
    assert row["fast_transfer"] == "YES"
    assert set(row.keys()) == set(src.RUNNING_HEADER)


def test_to_diff_row_matches_diff_header():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    row = e.to_diff_row("2026-05-28", "2026-05-27")
    assert set(row.keys()) == set(src.DIFF_HEADER)
    assert row["source"] == "Afternic"
    assert row["tld"] == "com"


def test_build_slack_message_empty():
    msg = src.build_slack_message(new_entries=[], sheet_url="https://sheet")
    assert "0 new qualifying names" in msg
    assert "https://sheet" in msg


def test_build_slack_message_with_entries():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    msg = src.build_slack_message(new_entries=[e], sheet_url="https://sheet")
    assert "Top movers:" in msg
    assert "table.com" in msg
    assert "afternic.com/domain/" in msg


def test_afternic_link_uses_afternic_url():
    e = src.entry_from_row({"domain": "table.com", "price": "500"})
    assert e.link == "https://www.afternic.com/domain/table.com"
