"""Tests for the Pipeline Raw Cache retention tool."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest

from marketplace_pipeline.tools import raw_cache_retention as rcr


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _ago(days: int) -> str:
    return (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()


def _make_service(structure: dict[str, list[dict]]) -> MagicMock:
    """Build a fake Drive service whose files().list() returns the children
    of whatever 'in parents' clause is in the query.

    `structure` is {parent_folder_id: [child dicts]}.
    """
    svc = MagicMock()
    files = svc.files.return_value
    updated: list[dict] = []

    def list_side_effect(*, q: str, **_kwargs):
        # Parse the parent id from "'<parent>' in parents and ..."
        parent = q.split("'", 2)[1]
        result = MagicMock()
        result.execute.return_value = {"files": structure.get(parent, [])}
        return result

    def update_side_effect(*, fileId, body, **_kw):
        updated.append({"id": fileId, "body": body})
        result = MagicMock()
        result.execute.return_value = {}
        return result

    files.list.side_effect = list_side_effect
    files.update.side_effect = update_side_effect

    svc._trashed_ids = updated
    return svc


def test_prune_trashes_only_old_date_subfolders(monkeypatch):
    from marketplace_pipeline import config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_registry", lambda: {
        "storage": {
            "pipeline_raw_cache_folder_id": "root",
            "pipeline_raw_cache_retention_days": 7,
        },
    })

    structure = {
        "root": [
            {"id": "src_a", "name": "namecheap_bin"},
            {"id": "src_b", "name": "afternic"},
        ],
        "src_a": [
            {"id": "today_a", "name": _today()},
            {"id": "old_a",   "name": _ago(30)},
        ],
        "src_b": [
            {"id": "today_b",  "name": _today()},
            {"id": "yest_b",   "name": _ago(1)},
            {"id": "ancient_b","name": _ago(60)},
        ],
    }
    svc = _make_service(structure)

    result = rcr.prune(retention_days=7, service=svc)

    assert result["scanned"] == 5
    assert result["trashed_count"] == 2
    trashed_ids = {row["folder_id"] for row in result["trashed"]}
    assert trashed_ids == {"old_a", "ancient_b"}
    # And the service got files.update called twice with trashed=True
    assert len(svc._trashed_ids) == 2
    for u in svc._trashed_ids:
        assert u["body"] == {"trashed": True}


def test_prune_dry_run_does_not_trash(monkeypatch):
    from marketplace_pipeline import config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_registry", lambda: {
        "storage": {"pipeline_raw_cache_folder_id": "root",
                    "pipeline_raw_cache_retention_days": 7},
    })

    structure = {
        "root": [{"id": "src_a", "name": "namecheap_bin"}],
        "src_a": [{"id": "old_a", "name": _ago(30)}],
    }
    svc = _make_service(structure)
    result = rcr.prune(retention_days=7, dry_run=True, service=svc)

    assert result["trashed_count"] == 1
    assert result["dry_run"] is True
    assert len(svc._trashed_ids) == 0  # nothing actually trashed


def test_prune_skips_non_date_named_folders(monkeypatch):
    from marketplace_pipeline import config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_registry", lambda: {
        "storage": {"pipeline_raw_cache_folder_id": "root",
                    "pipeline_raw_cache_retention_days": 7},
    })

    structure = {
        "root":  [{"id": "src_a", "name": "namecheap_bin"}],
        "src_a": [
            {"id": "old_a",     "name": _ago(30)},
            {"id": "junk",      "name": "README"},  # not a date — must be skipped
            {"id": "wrong_fmt", "name": "2026-13-99"},  # invalid date — skipped
        ],
    }
    svc = _make_service(structure)
    result = rcr.prune(retention_days=7, service=svc)

    assert result["scanned"] == 3
    assert result["trashed_count"] == 1
    assert result["kept"] == 2
    assert svc._trashed_ids[0]["id"] == "old_a"


def test_prune_raises_when_root_folder_not_configured(monkeypatch):
    from marketplace_pipeline import config as cfg_mod

    monkeypatch.setattr(cfg_mod, "load_registry", lambda: {"storage": {}})
    with pytest.raises(RuntimeError, match="pipeline_raw_cache_folder_id"):
        rcr.prune(retention_days=7, service=MagicMock())
