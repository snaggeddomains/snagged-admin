"""Unit tests for the auctions sheet writer."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.auctions import sheet as auc_sheet


# ---------- format_time_left ----------

def test_format_time_left_days_plus_hours():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now + timedelta(days=2, hours=3, minutes=15)
    assert auc_sheet.format_time_left(end, now=now) == "2d 3h"


def test_format_time_left_hours_plus_minutes():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now + timedelta(hours=4, minutes=12)
    assert auc_sheet.format_time_left(end, now=now) == "4h 12m"


def test_format_time_left_minutes_only():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now + timedelta(minutes=30)
    assert auc_sheet.format_time_left(end, now=now) == "30m"


def test_format_time_left_soon_when_seconds():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now + timedelta(seconds=30)
    assert auc_sheet.format_time_left(end, now=now) == "soon"


def test_format_time_left_ended_when_past():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now - timedelta(hours=1)
    assert auc_sheet.format_time_left(end, now=now) == "ended"


def test_format_time_left_treats_naive_datetime_as_utc():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end_naive = datetime(2026, 5, 28, 4, 12)  # no tzinfo
    assert auc_sheet.format_time_left(end_naive, now=now) == "4h 12m"


# ---------- row_from_listing ----------

def test_row_from_listing_parses_iso_string():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    listing = {
        "domain": "example.com",
        "end_time_utc": "2026-05-28T04:12:00+00:00",
        "price": 150,
        "platform": "Park.io",
    }
    row = auc_sheet.row_from_listing(listing, now=now)
    assert row[0] == "2026-05-28 04:12:00"
    assert row[1] == "4h 12m"
    assert row[2] == "example.com"
    assert row[3] == 150
    assert row[4] == "Park.io"


def test_row_from_listing_accepts_datetime_directly():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = now + timedelta(hours=2)
    row = auc_sheet.row_from_listing(
        {"domain": "x.com", "end_time_utc": end, "price": 50, "platform": "P"},
        now=now,
    )
    assert row[1] == "2h 0m"


def test_row_from_listing_blank_price_when_none():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    listing = {
        "domain": "x.com",
        "end_time_utc": "2026-05-28T04:00:00+00:00",
        "price": None,
        "platform": "P",
    }
    row = auc_sheet.row_from_listing(listing, now=now)
    assert row[3] == ""


# ---------- write() (with fake Sheets service) ----------

class _Executable:
    def __init__(self, result):
        self._result = result
    def execute(self):
        return self._result


class _Values:
    def __init__(self, service):
        self._s = service
    def get(self, **_kw):
        return _Executable({"values": list(self._s.rows)})
    def clear(self, **kw):
        self._s.clear_calls.append(kw)
        self._s.rows = []
        return _Executable({})
    def update(self, **kw):
        self._s.update_calls.append(kw)
        self._s.rows = list(kw.get("body", {}).get("values", []))
        return _Executable({})


class FakeService:
    def __init__(self, initial=None):
        self.rows = list(initial) if initial else []
        self.clear_calls = []
        self.update_calls = []
    def spreadsheets(self):
        s = self
        class _SP:
            def values(_self): return _Values(s)
        return _SP()


HEADER_ROW = ["end_time_utc", "time_left", "domain", "price", "platform"]


def _mk_row(end_str: str, domain: str, price=100, platform="Park.io", time_left="1d 0h"):
    return [end_str, time_left, domain, price, platform]


def test_write_to_empty_sheet():
    svc = FakeService(initial=[])
    stats = auc_sheet.write(
        spreadsheet_id="S1",
        new_rows=[
            _mk_row("2026-05-28 04:00:00", "a.com"),
            _mk_row("2026-05-28 05:00:00", "b.com"),
        ],
        service=svc,
    )
    assert stats == {"existing": 0, "added": 2, "deduped": 0, "total_after": 2}
    assert [r[2] for r in svc.rows] == ["a.com", "b.com"]


def test_write_prepends_new_above_existing():
    existing = [_mk_row("2026-05-27 04:00:00", "old.com")]
    svc = FakeService(initial=existing)
    stats = auc_sheet.write(
        spreadsheet_id="S1",
        new_rows=[_mk_row("2026-05-28 04:00:00", "new.com")],
        service=svc,
    )
    assert stats["added"] == 1
    domains = [r[2] for r in svc.rows]
    assert domains == ["new.com", "old.com"]  # new on top


def test_write_dedupes_by_domain_and_end_time():
    existing = [_mk_row("2026-05-28 04:00:00", "dup.com")]
    svc = FakeService(initial=existing)
    stats = auc_sheet.write(
        spreadsheet_id="S1",
        new_rows=[
            _mk_row("2026-05-28 04:00:00", "dup.com"),  # exact dup
            _mk_row("2026-05-28 05:00:00", "fresh.com"),
        ],
        service=svc,
    )
    assert stats["added"] == 1
    assert stats["deduped"] == 1


def test_write_dedup_is_case_insensitive_on_domain():
    existing = [_mk_row("2026-05-28 04:00:00", "Foo.com")]
    svc = FakeService(initial=existing)
    stats = auc_sheet.write(
        spreadsheet_id="S1",
        new_rows=[_mk_row("2026-05-28 04:00:00", "foo.com")],
        service=svc,
    )
    assert stats["added"] == 0
    assert stats["deduped"] == 1


def test_write_clear_and_update_called():
    svc = FakeService(initial=[_mk_row("2026-05-28 04:00:00", "x.com")])
    auc_sheet.write(
        spreadsheet_id="S1",
        new_rows=[_mk_row("2026-05-28 05:00:00", "y.com")],
        service=svc,
    )
    assert len(svc.clear_calls) == 1
    assert svc.clear_calls[0]["range"] == "Sheet1!A2:E"
    assert len(svc.update_calls) == 1
    assert svc.update_calls[0]["range"] == "Sheet1!A2"
    assert svc.update_calls[0]["valueInputOption"] == "USER_ENTERED"


def test_write_no_new_or_existing_results_in_clear_only():
    svc = FakeService(initial=[])
    stats = auc_sheet.write(spreadsheet_id="S1", new_rows=[], service=svc)
    assert stats == {"existing": 0, "added": 0, "deduped": 0, "total_after": 0}
    assert len(svc.clear_calls) == 1
    assert len(svc.update_calls) == 0  # nothing to write
