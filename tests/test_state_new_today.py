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
