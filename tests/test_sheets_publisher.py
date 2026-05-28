"""Unit tests for the shared Sheets publisher.

Uses a fake Sheets service that records clear/update calls and reflects
written rows back through the read() path, so multi-call sequences are
exercised without hitting Google.
"""
from __future__ import annotations

import pytest

from marketplace_pipeline.publishers import sheets as pub
from marketplace_pipeline.publishers.sheets import OwnershipMode


# ---------------------------------------------------------------------------
# Fake Sheets service
# ---------------------------------------------------------------------------

class _Executable:
    def __init__(self, result):
        self._result = result

    def execute(self):
        return self._result


class _Values:
    def __init__(self, service):
        self._s = service

    def get(self, **_kwargs):
        return _Executable({"values": list(self._s.rows)})

    def clear(self, **kwargs):
        self._s.clear_calls.append(kwargs)
        self._s.rows = []
        return _Executable({})

    def update(self, **kwargs):
        self._s.update_calls.append(kwargs)
        self._s.rows = list(kwargs.get("body", {}).get("values", []))
        return _Executable({})


class _Spreadsheets:
    def __init__(self, service):
        self._s = service

    def values(self):
        return _Values(self._s)


class FakeSheetsService:
    def __init__(self, initial_rows=None):
        self.rows = list(initial_rows) if initial_rows else []
        self.clear_calls = []
        self.update_calls = []

    def spreadsheets(self):
        return _Spreadsheets(self)


# ---------------------------------------------------------------------------
# REPLACE_SOURCE_ROWS
# ---------------------------------------------------------------------------

HEADER = ["domain", "price", "tld", "source", "date_added"]


def _make_row(domain, source, date, price=100, tld=".com"):
    return [domain, price, tld, source, date]


def _make_dict(domain, source, date, price=100, tld=".com"):
    return {"domain": domain, "price": price, "tld": tld, "source": source, "date_added": date}


def test_empty_sheet_writes_header_and_rows():
    svc = FakeSheetsService(initial_rows=[])
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="Namecheap",
        rows=[_make_dict("ex1.com", "Namecheap", "2026-05-28")],
        report_date="2026-05-28",
        default_header=HEADER,
        service=svc,
    )
    assert stats == {"removed": 0, "kept_today": 0, "added": 1, "total_after": 1}
    assert svc.rows[0] == HEADER
    assert svc.rows[1][0] == "ex1.com"


def test_drops_old_same_source_rows():
    initial = [
        HEADER,
        _make_row("oldday.com", "Namecheap", "2026-05-27"),  # different date -> drop
        _make_row("today.com",  "Namecheap", "2026-05-28"),  # keep
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="Namecheap",
        rows=[_make_dict("new.com", "Namecheap", "2026-05-28")],
        report_date="2026-05-28",
        service=svc,
    )
    assert stats["removed"] == 1
    assert stats["kept_today"] == 1
    assert stats["added"] == 1
    assert stats["total_after"] == 2

    written_domains = [r[0] for r in svc.rows[1:]]
    assert "oldday.com" not in written_domains
    assert "today.com" in written_domains
    assert "new.com" in written_domains
    # new rows come before today's kept rows
    assert written_domains.index("new.com") < written_domains.index("today.com")


def test_preserves_other_source_rows():
    initial = [
        HEADER,
        _make_row("af1.com",     "Afternic",  "2026-05-28"),
        _make_row("af-old.com",  "Afternic",  "2026-05-20"),
        _make_row("ncold.com",   "Namecheap", "2026-05-27"),
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="Namecheap",
        rows=[_make_dict("nc-new.com", "Namecheap", "2026-05-28")],
        report_date="2026-05-28",
        service=svc,
    )
    written_domains = [r[0] for r in svc.rows[1:]]
    # Afternic rows untouched (both dates), Namecheap old dropped, new added
    assert "af1.com" in written_domains
    assert "af-old.com" in written_domains
    assert "ncold.com" not in written_domains
    assert "nc-new.com" in written_domains
    assert stats["removed"] == 1
    assert stats["added"] == 1


def test_deduplicates_new_rows_against_existing_today_rows():
    """Re-run scenario: same domain already in today's rows shouldn't duplicate."""
    initial = [
        HEADER,
        _make_row("dup.com", "Namecheap", "2026-05-28"),
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="Namecheap",
        rows=[
            _make_dict("dup.com",  "Namecheap", "2026-05-28"),
            _make_dict("new.com",  "Namecheap", "2026-05-28"),
        ],
        report_date="2026-05-28",
        service=svc,
    )
    written_domains = [r[0] for r in svc.rows[1:]]
    assert written_domains.count("dup.com") == 1
    assert stats["added"] == 1
    assert stats["kept_today"] == 1


def test_source_match_is_case_insensitive():
    initial = [
        HEADER,
        _make_row("a.com", "NameCheap", "2026-05-27"),  # different casing
    ]
    svc = FakeSheetsService(initial_rows=initial)
    pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="namecheap",
        rows=[_make_dict("b.com", "Namecheap", "2026-05-28")],
        report_date="2026-05-28",
        service=svc,
    )
    written = [r[0] for r in svc.rows[1:]]
    assert "a.com" not in written  # dropped despite case mismatch
    assert "b.com" in written


def test_missing_source_column_raises():
    bad_header = ["domain", "price", "tld", "date_added"]  # no 'source'
    svc = FakeSheetsService(initial_rows=[bad_header])
    with pytest.raises(ValueError, match="source"):
        pub.write_rows(
            spreadsheet_id="S1",
            tab="Tab",
            mode=OwnershipMode.REPLACE_SOURCE_ROWS,
            source="Namecheap",
            rows=[],
            report_date="2026-05-28",
            service=svc,
        )


def test_missing_date_column_raises():
    bad_header = ["domain", "price", "tld", "source"]  # no 'date_added'
    svc = FakeSheetsService(initial_rows=[bad_header])
    with pytest.raises(ValueError, match="date_added"):
        pub.write_rows(
            spreadsheet_id="S1",
            tab="Tab",
            mode=OwnershipMode.REPLACE_SOURCE_ROWS,
            source="Namecheap",
            rows=[],
            report_date="2026-05-28",
            service=svc,
        )


def test_report_date_required():
    svc = FakeSheetsService(initial_rows=[HEADER])
    with pytest.raises(ValueError, match="report_date"):
        pub.write_rows(
            spreadsheet_id="S1",
            tab="Tab",
            mode=OwnershipMode.REPLACE_SOURCE_ROWS,
            source="Namecheap",
            rows=[],
            service=svc,
        )


def test_all_modes_implemented_now():
    """As of the atom_wholesale port, every OwnershipMode value is implemented."""
    svc = FakeSheetsService(initial_rows=[HEADER])
    for mode in OwnershipMode:
        # Just call; should not raise NotImplementedError. Some modes need
        # specific args (report_date for REPLACE_SOURCE_ROWS) so we provide.
        kwargs = dict(
            spreadsheet_id="S1",
            tab="Tab",
            mode=mode,
            source="Namecheap",
            rows=[],
            report_date="2026-05-28",
            service=svc,
        )
        # Should not raise NotImplementedError for any mode
        pub.write_rows(**kwargs)


# ---------- PREPEND_NEW_ROWS ----------

ATOM_HEADER = ["domain", "tld", "price", "source", "date_added"]


def test_prepend_new_rows_writes_above_existing():
    initial = [
        ATOM_HEADER,
        ["old.com", "com", 100, "Atom", "2026-05-27"],
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.PREPEND_NEW_ROWS,
        source="Atom",
        rows=[{"domain": "new.com", "tld": "com", "price": 200, "source": "Atom", "date_added": "2026-05-28"}],
        service=svc,
    )
    assert stats["added"] == 1
    domains = [r[0] for r in svc.rows[1:]]
    assert domains == ["new.com", "old.com"]


def test_prepend_new_rows_skips_existing_domain():
    initial = [
        ATOM_HEADER,
        ["dup.com", "com", 100, "Atom", "2026-05-27"],
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.PREPEND_NEW_ROWS,
        source="Atom",
        rows=[
            {"domain": "dup.com", "price": 500},  # already there
            {"domain": "new.com", "price": 999},
        ],
        service=svc,
    )
    assert stats["added"] == 1
    assert stats["skipped"] == 1
    domains = [r[0] for r in svc.rows[1:]]
    assert domains == ["new.com", "dup.com"]


def test_prepend_new_rows_bootstraps_empty_sheet():
    svc = FakeSheetsService(initial_rows=[])
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.PREPEND_NEW_ROWS,
        source="Atom",
        rows=[{"domain": "first.com", "tld": "com", "price": 100, "source": "Atom", "date_added": "2026-05-28"}],
        default_header=ATOM_HEADER,
        service=svc,
    )
    assert stats["added"] == 1
    assert svc.rows[0] == ATOM_HEADER
    assert svc.rows[1][0] == "first.com"


def test_prepend_new_rows_raises_when_key_column_missing():
    bad = ["price", "tld"]  # no 'domain'
    svc = FakeSheetsService(initial_rows=[bad])
    with pytest.raises(ValueError, match="domain"):
        pub.write_rows(
            spreadsheet_id="S1",
            tab="Tab",
            mode=OwnershipMode.PREPEND_NEW_ROWS,
            source="Atom",
            rows=[{"domain": "a.com"}],
            service=svc,
        )


# ---------------------------------------------------------------------------
# REBUILD_OWNED_SLICE
# ---------------------------------------------------------------------------

RUNNING_HEADER = [
    "domain", "price", "tld", "zipf_score", "fast_transfer",
    "quality_score", "deal_score", "link", "date_added",
]


def test_rebuild_owned_slice_default_predicate_uses_source_column():
    # Tab has a "source" column; default predicate matches on it
    header = ["domain", "price", "source"]
    initial = [
        header,
        ["af1.com", 100, "Afternic"],
        ["af-old.com", 200, "Afternic"],
        ["nc1.com", 150, "Namecheap"],
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REBUILD_OWNED_SLICE,
        source="Afternic",
        rows=[{"domain": "af-new.com", "price": 999, "source": "Afternic"}],
        service=svc,
    )
    assert stats["removed"] == 2  # both af1 and af-old dropped
    assert stats["added"] == 1
    assert stats["preserved"] == 1  # nc1.com kept

    written = [r[0] for r in svc.rows[1:]]
    assert "af-new.com" in written
    assert "nc1.com" in written
    assert "af1.com" not in written
    assert "af-old.com" not in written
    # new row appears before preserved foreign rows
    assert written.index("af-new.com") < written.index("nc1.com")


def test_rebuild_owned_slice_custom_predicate_link_contains():
    """Legacy Running Good Deals: identify Afternic rows by link, no source column."""
    initial = [
        RUNNING_HEADER,
        ["a.com", 100, "com", 5.5, "YES", 5.5, 100.0, "https://www.afternic.com/domain/a.com", "2026-05-28"],
        ["b.com", 200, "com", 4.0, "NO",  4.0, 50.0,  "https://atom.com/name/b",                 "2026-05-28"],
    ]
    svc = FakeSheetsService(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Running Good Deals",
        mode=OwnershipMode.REBUILD_OWNED_SLICE,
        source="Afternic",
        rows=[{
            "domain": "c.com", "price": 300, "tld": "com", "zipf_score": 6.0,
            "fast_transfer": "YES", "quality_score": 6.0, "deal_score": 200.0,
            "link": "https://www.afternic.com/domain/c.com", "date_added": "2026-05-28",
        }],
        owner_predicate=lambda r: "afternic.com/domain/" in str(r.get("link", "")).lower(),
        service=svc,
    )
    assert stats["removed"] == 1   # a.com (Afternic-link) dropped
    assert stats["added"] == 1     # c.com inserted
    assert stats["preserved"] == 1 # b.com (Atom-link) preserved


def test_rebuild_owned_slice_empty_sheet_uses_default_header():
    svc = FakeSheetsService(initial_rows=[])
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REBUILD_OWNED_SLICE,
        source="Afternic",
        rows=[{"domain": "a.com", "source": "Afternic"}],
        default_header=["domain", "source"],
        service=svc,
    )
    assert stats["added"] == 1
    assert svc.rows[0] == ["domain", "source"]


# ---------------------------------------------------------------------------
# APPEND_IF_MISSING
# ---------------------------------------------------------------------------


class _ValuesWithAppend(_Values):
    def append(self, **kwargs):
        self._s.append_calls.append(kwargs)
        # Reflect the append into our reads: extend rows with appended values
        appended_values = kwargs.get("body", {}).get("values", [])
        self._s.rows = list(self._s.rows) + list(appended_values)
        return _Executable({})


class FakeSheetsServiceWithAppend(FakeSheetsService):
    def __init__(self, initial_rows=None):
        super().__init__(initial_rows=initial_rows)
        self.append_calls = []

    def spreadsheets(self):
        s = self

        class _SP:
            def values(self_inner):
                return _ValuesWithAppend(s)
        return _SP()


def test_append_if_missing_only_appends_new_domains():
    initial = [
        RUNNING_HEADER,
        ["a.com", 100, "com", 5.0, "NO", 5.0, 50.0, "https://x", "2026-05-28"],
    ]
    svc = FakeSheetsServiceWithAppend(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Running Good Deals",
        mode=OwnershipMode.APPEND_IF_MISSING,
        source="Atom",
        rows=[
            {"domain": "a.com", "price": 999},  # duplicate -> skip
            {"domain": "b.com", "price": 200, "tld": "com", "zipf_score": 4.0,
             "fast_transfer": "NO", "quality_score": 4.0, "deal_score": 20.0,
             "link": "https://atom.com/name/b", "date_added": "2026-05-28"},
        ],
        service=svc,
    )
    assert stats["added"] == 1
    assert stats["skipped"] == 1
    assert len(svc.append_calls) == 1
    appended_domains = [r[0] for r in svc.append_calls[0]["body"]["values"]]
    assert appended_domains == ["b.com"]


def test_append_if_missing_skips_when_all_present():
    initial = [
        RUNNING_HEADER,
        ["a.com", 100, "com", 5.0, "NO", 5.0, 50.0, "https://x", "2026-05-28"],
    ]
    svc = FakeSheetsServiceWithAppend(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Running Good Deals",
        mode=OwnershipMode.APPEND_IF_MISSING,
        source="Atom",
        rows=[{"domain": "a.com"}],
        service=svc,
    )
    assert stats["added"] == 0
    assert stats["skipped"] == 1
    assert len(svc.append_calls) == 0  # nothing to append


def test_append_if_missing_empty_sheet_writes_header_then_appends():
    svc = FakeSheetsServiceWithAppend(initial_rows=[])
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Running Good Deals",
        mode=OwnershipMode.APPEND_IF_MISSING,
        source="Atom",
        rows=[{"domain": "a.com", "price": 100}],
        default_header=["domain", "price"],
        service=svc,
    )
    assert stats["added"] == 1
    # header written via update, then row appended
    assert len(svc.update_calls) == 1
    assert svc.update_calls[0]["body"]["values"] == [["domain", "price"]]
    assert len(svc.append_calls) == 1


def test_append_if_missing_dedupes_within_batch():
    """Two new rows with same domain key in one call → only one is appended."""
    initial = [RUNNING_HEADER]
    svc = FakeSheetsServiceWithAppend(initial_rows=initial)
    stats = pub.write_rows(
        spreadsheet_id="S1",
        tab="Running Good Deals",
        mode=OwnershipMode.APPEND_IF_MISSING,
        source="Atom",
        rows=[
            {"domain": "a.com", "price": 100},
            {"domain": "a.com", "price": 200},  # dup within batch
            {"domain": "b.com", "price": 300},
        ],
        service=svc,
    )
    assert stats["added"] == 2
    assert stats["skipped"] == 1


def test_clear_and_update_actually_called():
    svc = FakeSheetsService(initial_rows=[])
    pub.write_rows(
        spreadsheet_id="S1",
        tab="Tab",
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source="Namecheap",
        rows=[_make_dict("a.com", "Namecheap", "2026-05-28")],
        report_date="2026-05-28",
        default_header=HEADER,
        service=svc,
    )
    assert len(svc.clear_calls) == 1
    assert svc.clear_calls[0]["spreadsheetId"] == "S1"
    assert "'Tab'!A:Z" in svc.clear_calls[0]["range"]
    assert len(svc.update_calls) == 1
    assert svc.update_calls[0]["valueInputOption"] == "USER_ENTERED"
