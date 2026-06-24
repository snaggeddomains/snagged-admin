"""Unit tests for state.write_new_today (the 'new today' drill-down feed list)."""
from __future__ import annotations

import pytest

from marketplace_pipeline import state


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_DIR", tmp_path)


def test_write_new_today_dedupes_lowercases_skips_empty():
    state.write_new_today("src", ["A.com", "a.com", "  ", "b.COM", "", "c.net"])
    saved = state.read_json("src", "new_today.json", default={})
    assert saved["domains"] == ["a.com", "b.com", "c.net"]
    assert saved["count"] == 3
    assert saved["capped"] is False
    assert saved["source"] == "src"


def test_write_new_today_caps_large_lists(monkeypatch):
    monkeypatch.setattr(state, "NEW_TODAY_CAP", 5)
    state.write_new_today("src", [f"d{i}.com" for i in range(20)])
    saved = state.read_json("src", "new_today.json", default={})
    assert saved["count"] == 5
    assert saved["capped"] is True


def test_write_new_today_is_fail_safe_on_bad_input(monkeypatch):
    # Never raise — a recording failure must not fail the source run.
    state.write_new_today("src", None)  # type: ignore[arg-type]
    saved = state.read_json("src", "new_today.json", default={})
    assert saved["domains"] == []
    assert saved["count"] == 0


def test_write_new_today_precomputes_mub_subset():
    # The MUB subset is persisted so the opportunities report can filter by it.
    state.write_new_today("src", ["ambrino.com", "google.com", "batino.com"])
    saved = state.read_json("src", "new_today.json", default={})
    assert set(saved["mub"]) == {"ambrino.com", "batino.com"}
    assert "google.com" not in saved["mub"]


def test_write_json_annotates_is_mub_on_auction_snapshots():
    # Auction snapshots (list of dicts) get is_mub stamped at write time; dict
    # snapshots (SNAP {domain: price}) are left untouched.
    state.write_json("src", "snapshot.json", [{"domain": "ambrino.com"}, {"domain": "google.com"}])
    rows = state.read_json("src", "snapshot.json", default=[])
    flags = {r["domain"]: r["is_mub"] for r in rows}
    assert flags == {"ambrino.com": True, "google.com": False}

    state.write_json("src", "snapshot.json", {"ambrino.com": 100})  # dict shape untouched
    assert state.read_json("src", "snapshot.json", default={}) == {"ambrino.com": 100}
