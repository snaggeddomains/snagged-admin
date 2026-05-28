"""Tests for the pipeline doctor command."""
from __future__ import annotations

import pytest

from marketplace_pipeline.tools import doctor


def test_check_env_reports_failures_for_missing_required(monkeypatch, capsys):
    for v in doctor.REQUIRED_ENV:
        monkeypatch.delenv(v, raising=False)
    failures = doctor._check_env()
    assert failures == len(doctor.REQUIRED_ENV)
    out = capsys.readouterr().out
    for v in doctor.REQUIRED_ENV:
        assert f"FAIL {v}" in out


def test_check_env_reports_ok_when_required_set(monkeypatch, capsys):
    for v in doctor.REQUIRED_ENV:
        monkeypatch.setenv(v, "x")
    failures = doctor._check_env()
    assert failures == 0
    out = capsys.readouterr().out
    for v in doctor.REQUIRED_ENV:
        assert f"OK   {v}" in out


def test_check_registry_passes(capsys):
    failures = doctor._check_registry()
    assert failures == 0
    out = capsys.readouterr().out
    assert "loaded" in out
    assert "sources" in out


def test_check_publishers_all_importable(capsys):
    failures = doctor._check_publishers()
    assert failures == 0
    out = capsys.readouterr().out
    assert "OK   marketplace_pipeline.publishers.slack" in out
    assert "OK   marketplace_pipeline.auctions.orchestrator" in out


def test_check_source_imports_no_failures(capsys):
    failures = doctor._check_source_imports()
    assert failures == 0
    out = capsys.readouterr().out
    # Known wired sources should appear with OK
    assert "OK   namecheap_bin" in out
    assert "OK   atom_daily" in out
    # Known unwired (dynadot/namesilo) should appear as TODO, not FAIL
    assert "TODO dynadot_auctions" in out


def test_main_returns_zero_when_only_optional_env_missing(monkeypatch, capsys):
    """With all REQUIRED env vars set, doctor exits 0 even with optionals
    unset (which is the typical local-dev state)."""
    for v in doctor.REQUIRED_ENV:
        monkeypatch.setenv(v, "x")
    # Don't set optionals — should still pass
    rc = doctor.main([])
    out = capsys.readouterr().out
    assert "OK -- everything checks out." in out
    assert rc == 0


def test_main_returns_nonzero_when_required_env_missing(monkeypatch, capsys):
    for v in doctor.REQUIRED_ENV:
        monkeypatch.delenv(v, raising=False)
    rc = doctor.main([])
    out = capsys.readouterr().out
    assert "FAIL --" in out
    assert rc != 0
