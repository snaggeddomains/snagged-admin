"""Unit tests for dynadot_auctions and namesilo_auctions pure helpers."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import dynadot_auctions as dyn
from marketplace_pipeline.sources import namesilo_auctions as nsi


# ============================================================
# Dynadot
# ============================================================

def _dyn_row(domain="table.com", end_offset_hours=4, price=120, auction_id="A1", bids=2):
    base = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = base + timedelta(hours=end_offset_hours)
    return {
        "utf_name": domain,
        "current_bid_price": price,
        "end_time_stamp": int(end.timestamp() * 1000),
        "bids": bids,
        "auction_id": auction_id,
    }


def test_dyn_normalize_row_accepts_clean():
    out = dyn._normalize_row(_dyn_row())
    assert out is not None
    assert out["domain"] == "table.com"
    assert out["platform"] == "Dynadot"
    assert out["price"] == 120.0
    assert out["bid_count"] == 2
    assert out["link"] == "https://www.dynadot.com/market/auction/A1.html"


def test_dyn_normalize_row_rejects_disallowed_tld():
    assert dyn._normalize_row(_dyn_row(domain="trash.xyz")) is None


def test_dyn_normalize_row_returns_none_without_timestamp():
    row = _dyn_row()
    row["end_time_stamp"] = None
    assert dyn._normalize_row(row) is None


def test_dyn_normalize_row_handles_missing_price():
    row = _dyn_row()
    row["current_bid_price"] = ""
    assert dyn._normalize_row(row)["price"] is None


def test_dyn_normalize_row_link_none_when_no_auction_id():
    row = _dyn_row()
    row["auction_id"] = None
    assert dyn._normalize_row(row)["link"] is None


class _FakeDynadotSession:
    def __init__(self, pages: list[list[dict]]):
        self.pages = pages
        self.calls = 0

    def get(self, url, **_kw):
        idx = self.calls
        self.calls += 1
        body = self.pages[idx] if idx < len(self.pages) else []

        class _Resp:
            status_code = 200
            def raise_for_status(self): pass
            def json(_self):
                return {"status": "success", "auction_list": body}
        return _Resp()


def test_dyn_fetch_and_filter_paginates_until_empty():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    pages = [
        [_dyn_row(domain="a.com", end_offset_hours=2, auction_id="X1")],
        [_dyn_row(domain="b.com", end_offset_hours=4, auction_id="X2")],
        [],  # empty page stops pagination
    ]
    sess = _FakeDynadotSession(pages)
    listings, raw = dyn.fetch_and_filter(
        api_key="k", api_secret="s", now=now, session=sess,
    )
    assert [L["domain"] for L in listings] == ["a.com", "b.com"]
    assert raw["meta"]["pages_fetched"] == 2


def test_dyn_fetch_and_filter_stops_when_past_horizon():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    # Every row is beyond the 24h horizon
    pages = [
        [_dyn_row(domain="a.com", end_offset_hours=48)],
        [],
    ]
    sess = _FakeDynadotSession(pages)
    listings, _raw = dyn.fetch_and_filter(
        api_key="k", api_secret="s", now=now, session=sess,
    )
    assert listings == []


# ============================================================
# NameSilo
# ============================================================

@pytest.mark.parametrize("raw,is_some", [
    ("2026-05-29T10:00:00Z", True),
    ("2026-05-29T10:00:00+00:00", True),
    ("2026-05-29 10:00:00", True),   # space separator (legacy quirk)
    ("", False),
    (None, False),
    ("garbage", False),
])
def test_nsi_parse_time(raw, is_some):
    out = nsi._parse_time(raw)
    if is_some:
        assert out is not None
        assert out.tzinfo == timezone.utc
    else:
        assert out is None


def _nsi_row(domain="table.com", end_offset_hours=12, price=100, bids=3):
    base = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    end = base + timedelta(hours=end_offset_hours)
    return {
        "domainName": domain,
        "auctionEndsOnUtc": end.isoformat(),
        "currentBid": price,
        "bidsQuantity": bids,
        "url": "https://nsi/x",
    }


def test_nsi_normalize_row_accepts_clean():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    cutoff = now + timedelta(hours=48)
    out = nsi._normalize_row(_nsi_row(), now=now, cutoff=cutoff)
    assert out is not None
    assert out["domain"] == "table.com"
    assert out["platform"] == "NameSilo"
    assert out["price"] == 100.0
    assert out["bid_count"] == 3


def test_nsi_normalize_row_rejects_disallowed_tld():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    cutoff = now + timedelta(hours=48)
    assert nsi._normalize_row(_nsi_row(domain="trash.xyz"), now=now, cutoff=cutoff) is None


def test_nsi_normalize_row_rejects_outside_window():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    cutoff = now + timedelta(hours=48)
    past = _nsi_row(end_offset_hours=-1)
    assert nsi._normalize_row(past, now=now, cutoff=cutoff) is None
    future = _nsi_row(end_offset_hours=200)
    assert nsi._normalize_row(future, now=now, cutoff=cutoff) is None


def test_nsi_normalize_row_falls_back_to_opening_bid():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    cutoff = now + timedelta(hours=48)
    row = _nsi_row(price=None)
    row["openingBid"] = 50
    assert nsi._normalize_row(row, now=now, cutoff=cutoff)["price"] == 50.0


class _FakeNamesiloSession:
    def __init__(self, pages: dict[int, list[dict]]):
        self.pages = pages
        self.calls: list[int] = []

    def get(self, url, *, params, **_kw):
        page = params["page"]
        self.calls.append(page)
        rows = self.pages.get(page, [])

        class _Resp:
            status_code = 200
            def raise_for_status(self): pass
            def json(_self):
                return {"reply": {"body": rows}}
        return _Resp()


def test_nsi_determine_start_page_fast_forwards_past_stale():
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    pages = {
        1: [_nsi_row(end_offset_hours=-200)],   # stale
        26: [_nsi_row(end_offset_hours=10)],     # in-window
    }
    sess = _FakeNamesiloSession(pages)
    start = nsi._determine_start_page(sess, api_key="k", now=now, jump=25)
    # After jumping to page 26 and finding in-window, should return 26-25 = 1
    assert start == 1


def test_nsi_fetch_and_filter_iterates_after_start_page(monkeypatch):
    now = datetime(2026, 5, 28, 0, 0, tzinfo=timezone.utc)
    pages = {
        1: [_nsi_row(domain="a.com", end_offset_hours=10)],
        2: [_nsi_row(domain="b.com", end_offset_hours=20)],
        3: [],
    }
    sess = _FakeNamesiloSession(pages)
    # Skip the sleep calls so tests run fast
    monkeypatch.setattr(nsi.time, "sleep", lambda *_a, **_kw: None)
    listings, _raw = nsi.fetch_and_filter(api_key="k", now=now, session=sess)
    assert [L["domain"] for L in listings] == ["a.com", "b.com"]
