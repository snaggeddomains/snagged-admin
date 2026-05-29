"""Tests for the universe filter + writer + sync tool."""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pytest

from marketplace_pipeline.filters import universe as univ
from marketplace_pipeline.universe import writer as uw
from marketplace_pipeline.tools import universe_sync


# ---------- filter ----------

@pytest.mark.parametrize("domain,expected", [
    ("table.com",   True),
    ("brand.ai",    True),
    ("hello.xyz",   True),
    ("brand.dev",   True),
    ("hello.co",    True),
    ("xyz.com",     True),     # 3-letter SLD allowed
    ("trash.tv",    False),    # disallowed TLD
    ("ocean.io",    False),    # .io was dropped from universe
    ("brand.app",   False),    # .app was dropped from universe
    ("a.com",       False),    # SLD too short (1 char)
    ("abcdefghijklmno.com", False),  # SLD too long (15 chars)
    ("table7.com",  False),    # digit in SLD
    ("foo-bar.com", False),    # hyphen
    ("ystrmchk.com", True),    # 7-consonant run allowed now (broad universe)
])
def test_passes_universe_filter(domain, expected):
    assert univ.passes_universe_filter(domain) is expected


def test_filter_requires_vowel():
    # all-consonant SLD should fail "require_vowel"
    assert univ.passes_universe_filter("brnk.com") is False


def test_max_consonant_run_helper():
    assert univ.max_consonant_run("table") == 2   # 't','bl' → max 2
    assert univ.max_consonant_run("strng") == 5
    assert univ.max_consonant_run("ai") == 0


# ---------- writer.normalize_listing ----------

def test_normalize_listing_returns_row_for_clean_listing():
    row = uw.normalize_listing(
        "namecheap_bin",
        {"domain": "table.com", "price": 100},
        observed_date="2026-05-28",
    )
    assert row is not None
    assert row["domain"] == "table.com"
    assert row["sld"] == "table"
    assert row["tld"] == ".com"
    assert row["sld_length"] == 5
    assert row["source"] == "namecheap_bin"
    assert row["observed_date"] == "2026-05-28"
    assert row["price"] == 100.0


def test_normalize_listing_returns_none_when_filter_rejects():
    row = uw.normalize_listing(
        "src", {"domain": "trash.tv", "price": 100},
        observed_date="2026-05-28",
    )
    assert row is None


def test_normalize_listing_handles_missing_price():
    row = uw.normalize_listing(
        "src", {"domain": "table.com"},
        observed_date="2026-05-28",
    )
    assert row is not None
    assert row["price"] is None


def test_normalize_listing_empty_price_string_becomes_none():
    row = uw.normalize_listing(
        "src", {"domain": "table.com", "price": ""},
        observed_date="2026-05-28",
    )
    assert row["price"] is None


# ---------- writer.merge_observations ----------

def test_merge_collapses_multi_source_same_domain():
    rows = [
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "source": "namecheap_bin", "observed_date": "2026-05-28",
         "price": 100, "zipf_score": 5.0},
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "source": "afternic", "observed_date": "2026-05-28",
         "price": 200, "zipf_score": 5.0},
    ]
    merged = uw.merge_observations(rows)
    assert len(merged) == 1
    assert set(merged[0]["sources"]) == {"namecheap_bin", "afternic"}
    assert merged[0]["prices"] == {"namecheap_bin": 100, "afternic": 200}


def test_merge_drops_none_prices_from_map():
    rows = [
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "source": "namecheap_bin", "observed_date": "2026-05-28",
         "price": None, "zipf_score": 5.0},
    ]
    merged = uw.merge_observations(rows)
    assert merged[0]["prices"] == {}


def test_merge_dedupes_sources_within_one_domain():
    """A source listing the same domain twice should appear once in sources."""
    rows = [
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "source": "namecheap_bin", "observed_date": "2026-05-28",
         "price": 100, "zipf_score": 5.0},
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "source": "namecheap_bin", "observed_date": "2026-05-28",
         "price": 100, "zipf_score": 5.0},
    ]
    merged = uw.merge_observations(rows)
    assert merged[0]["sources"] == ["namecheap_bin"]


# ---------- writer.write_parquet ----------

def test_write_parquet_creates_file_and_returns_row_count(tmp_path: Path):
    out = tmp_path / "obs.parquet"
    rows = [{
        "domain": "table.com", "sld": "table", "tld": ".com",
        "sld_length": 5, "observed_date": "2026-05-28",
        "zipf_score": 5.0,
        "sources": ["namecheap_bin"],
        "prices": {"namecheap_bin": 100.0},
    }]
    n = uw.write_parquet(rows, out)
    assert n == 1
    assert out.exists()
    assert out.stat().st_size > 0


def test_write_parquet_empty_input_creates_empty_file_with_schema(tmp_path: Path):
    out = tmp_path / "empty.parquet"
    n = uw.write_parquet([], out)
    assert n == 0
    assert out.exists()  # empty schema-only file


# ---------- writer.upload_to_r2 ----------

def test_upload_to_r2_returns_none_when_env_missing(monkeypatch):
    for v in ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT"):
        monkeypatch.delenv(v, raising=False)
    assert uw.upload_to_r2(Path("/tmp/x.parquet"), observed_date="2026-05-28") is None


# ---------- universe_sync ----------

def test_collect_snapshots_walks_state(tmp_path: Path, monkeypatch):
    from marketplace_pipeline import state as state_mod
    monkeypatch.setattr(state_mod, "STATE_DIR", tmp_path)

    # Two sources with snapshots
    state_mod.write_json("namecheap_bin", "snapshot.json", [
        {"domain": "table.com", "price": 100},
        {"domain": "trash.tv",  "price": 50},  # filter rejects
    ])
    state_mod.write_json("afternic", "snapshot.json", [
        {"domain": "ocean.com", "price": 200},
    ])

    rows, counts = universe_sync.collect_snapshots(today="2026-05-28")
    assert counts.get("namecheap_bin") == 1
    assert counts.get("afternic") == 1
    domains = {r["domain"] for r in rows}
    assert domains == {"table.com", "ocean.com"}


def test_universe_sync_main_dry_run(tmp_path: Path, monkeypatch, capsys):
    from marketplace_pipeline import state as state_mod
    monkeypatch.setattr(state_mod, "STATE_DIR", tmp_path)

    state_mod.write_json("namecheap_bin", "snapshot.json", [
        {"domain": "table.com", "price": 100},
    ])
    rc = universe_sync.main(["--dry-run"])
    out = capsys.readouterr().out
    assert rc == 0
    assert "dry-run" in out
    # State file should still get written
    status = state_mod.read_json("universe_sync", "run_status.json", default=None)
    assert status is not None
    assert status["dry_run"] is True
    assert status["merged_rows"] >= 1
