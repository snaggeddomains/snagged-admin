"""Tests for the auctions orchestrator and watchdog helpers.

The full end-to-end run() functions are exercised in CI against real
producers; here we cover the pure helpers and env-var contract.
"""
from __future__ import annotations

import os

import pytest

from marketplace_pipeline import auctions, state
from marketplace_pipeline.auctions import orchestrator, watchdog


# ---------- orchestrator_mode_active ----------

def test_orchestrator_mode_active_reads_env_var(monkeypatch):
    monkeypatch.delenv(auctions.ORCHESTRATOR_ENV, raising=False)
    assert auctions.orchestrator_mode_active() is False

    monkeypatch.setenv(auctions.ORCHESTRATOR_ENV, "1")
    assert auctions.orchestrator_mode_active() is True

    monkeypatch.setenv(auctions.ORCHESTRATOR_ENV, "")
    # Empty string is falsy in Python's `bool(os.environ.get(...))`
    assert auctions.orchestrator_mode_active() is False


# ---------- _label_for ----------

def test_label_for_known_source():
    label = orchestrator._label_for("parkio_auctions")
    assert label == "Park.io"


def test_label_for_unknown_source_humanizes_id():
    label = orchestrator._label_for("some_unknown_producer_xyz")
    assert label == "Some Unknown Producer Xyz"


# ---------- _build_slack_sections ----------

@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_DIR", tmp_path)


def test_build_slack_sections_skips_failed_producers():
    state.write_json("src_a", "snapshot.json", [
        {"domain": "a.com", "end_time_utc": "2026-05-29T10:00:00+00:00"}
    ])
    statuses = [
        {"source": "src_a", "label": "Source A", "status": "ok",      "generated_at": "x"},
        {"source": "src_b", "label": "Source B", "status": "failed",  "generated_at": "x"},
    ]
    sections = orchestrator._build_slack_sections(statuses)
    # Only one section, for src_a
    assert len(sections) == 1
    flat = "\n".join("\n".join(s) for s in sections)
    assert "Source A" in flat
    assert "a.com" in flat
    assert "Source B" not in flat


def test_build_slack_sections_handles_empty_snapshot():
    statuses = [
        {"source": "src_a", "label": "Source A", "status": "ok", "generated_at": "x"},
    ]
    # No snapshot.json written for src_a; should still produce a section
    # that just reports 0 listings.
    sections = orchestrator._build_slack_sections(statuses)
    assert len(sections) == 1
    flat = "\n".join(sections[0])
    assert "Source A" in flat
    assert "0 auctions" in flat


def test_build_slack_sections_skips_listings_without_end_time():
    state.write_json("src_a", "snapshot.json", [
        {"domain": "a.com", "end_time_utc": "2026-05-29T10:00:00+00:00"},
        {"domain": "b.com", "end_time_utc": None},
    ])
    statuses = [
        {"source": "src_a", "label": "Source A", "status": "ok", "generated_at": "x"},
    ]
    sections = orchestrator._build_slack_sections(statuses)
    flat = "\n".join(sections[0])
    assert "a.com" in flat
    assert "b.com" not in flat


# ---------- _all_enriched + _mub_section (the standalone MUB picks post) ----------

def test_all_enriched_flattens_ok_producers():
    state.write_json("src_a", "snapshot.json", [
        {"domain": "ambrino.com", "end_time_utc": "2026-05-29T10:00:00+00:00", "platform": "GoDaddy"},
    ])
    statuses = [
        {"source": "src_a", "label": "Source A", "status": "ok", "generated_at": "x"},
        {"source": "src_b", "label": "Source B", "status": "failed", "generated_at": "x"},
    ]
    rows = orchestrator._all_enriched(statuses)
    assert [r["domain"] for r in rows] == ["ambrino.com"]
    assert rows[0]["time_left"]            # enriched


def test_mub_section_picks_only_mub_with_source():
    listings = [
        {"domain": "ambrino.com", "price": 120, "time_left": "2d", "platform": "Dynadot"},
        {"domain": "google.com", "price": 50, "time_left": "4h", "platform": "GoDaddy"},
    ]
    section = orchestrator._mub_section(listings)
    flat = "\n".join(section)
    assert "MUB picks" in flat
    assert "ambrino.com" in flat and "Dynadot" in flat
    assert "google.com" not in flat


def test_mub_section_none_when_no_hits():
    assert orchestrator._mub_section([{"domain": "google.com", "time_left": "4h"}]) is None


# ---------- watchdog: no orchestrator status ----------

def test_watchdog_no_status_file_skips():
    # state/auctions/refresh_status.json absent
    rc = watchdog.run()
    assert rc == 0
    status = state.read_json("auctions_watchdog", "run_status.json", default=None)
    assert status is not None
    assert status["status"] == "skipped"


def test_watchdog_all_ok_no_retries():
    state.write_json("auctions", "refresh_status.json", [
        {"source": "src_a", "label": "Source A", "status": "ok", "generated_at": "x"},
        {"source": "src_b", "label": "Source B", "status": "ok", "generated_at": "x"},
    ])
    rc = watchdog.run()
    assert rc == 0
    s = state.read_json("auctions_watchdog", "run_status.json", default={})
    assert s["status"] == "ok"
    assert s["retried"] == 0


def test_watchdog_still_failed_after_retry_exits_nonzero(monkeypatch):
    # A producer that was failed and stays failed after the retry pass must make
    # run() exit non-zero, so the failure propagates to the SNAP Orchestrator's
    # conclusion (which fires the failure→issue + autofix workflow_run chain).
    state.write_json("auctions", "refresh_status.json", [
        {"source": "src_a", "label": "Source A", "status": "failed", "generated_at": "x"},
    ])
    monkeypatch.setattr(watchdog, "_retry_one", lambda sid: {
        "source": sid, "label": "Source A", "status": "failed", "generated_at": "x",
    })
    rc = watchdog.run()
    assert rc == 1
    s = state.read_json("auctions_watchdog", "run_status.json", default={})
    assert s["status"] == "failed"
    assert s["still_failed"] == ["src_a"]
    assert s["recovered"] == 0
