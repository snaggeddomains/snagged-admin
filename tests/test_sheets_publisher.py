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


def test_unimplemented_modes_raise_not_implemented():
    svc = FakeSheetsService(initial_rows=[HEADER])
    for mode in (
        OwnershipMode.PREPEND_NEW_ROWS,
        OwnershipMode.APPEND_IF_MISSING,
        OwnershipMode.REBUILD_OWNED_SLICE,
    ):
        with pytest.raises(NotImplementedError):
            pub.write_rows(
                spreadsheet_id="S1",
                tab="Tab",
                mode=mode,
                source="Namecheap",
                rows=[],
                report_date="2026-05-28",
                service=svc,
            )


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
