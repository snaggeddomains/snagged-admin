"""Tests for the Supabase upsert path in universe_sync."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from marketplace_pipeline.universe import supabase_writer as sw


# ---------- merged_to_universe_row ----------

def test_merged_to_universe_row_picks_lowest_price():
    merged = {
        "domain": "table.com",
        "sld": "table",
        "tld": ".com",
        "sld_length": 5,
        "observed_date": "2026-05-29",
        "zipf_score": 4.2,
        "sources": ["afternic", "atom_daily"],
        "prices": {"afternic": 99.0, "atom_daily": 1500.0},
    }
    row = sw.merged_to_universe_row(merged)
    assert row["best_price"] == 99.0
    assert row["best_price_source"] == "afternic"
    assert row["domain"] == "table.com"
    assert row["sources"] == ["afternic", "atom_daily"]


def test_merged_to_universe_row_populates_cheap_enrichment_fields():
    """num_words, num_syllables, is_dictionary_word are computed at ingest
    so they're indexable in Postgres without per-query wordfreq calls."""
    # Single-word case
    row = sw.merged_to_universe_row({
        "domain": "table.com", "sld": "table", "tld": ".com",
        "sld_length": 5, "observed_date": "2026-05-29",
        "zipf_score": 4.2, "sources": ["afternic"], "prices": {},
    })
    assert row["num_words"] == 1
    assert row["is_dictionary_word"] is True
    assert row["num_syllables"] >= 1  # table = 2 syllables (ta-ble), but heuristic may give 1-2

    # Two-word case
    row2 = sw.merged_to_universe_row({
        "domain": "freshcoffee.com", "sld": "freshcoffee", "tld": ".com",
        "sld_length": 11, "observed_date": "2026-05-29",
        "zipf_score": 0.0, "sources": ["atom_daily"], "prices": {},
    })
    assert row2["num_words"] == 2
    assert row2["is_dictionary_word"] is False
    assert row2["num_syllables"] >= 2


def test_merged_to_universe_row_handles_empty_prices():
    """Rows with no observed price should produce null best_price / source."""
    merged = {
        "domain": "ocean.com",
        "sld": "ocean",
        "tld": ".com",
        "sld_length": 5,
        "observed_date": "2026-05-29",
        "zipf_score": 4.7,
        "sources": ["namecheap_bin"],
        "prices": {},
    }
    row = sw.merged_to_universe_row(merged)
    assert row["best_price"] is None
    assert row["best_price_source"] is None


def test_merged_to_universe_row_preserves_zipf_none():
    """Non-alpha SLDs have zipf_score=None upstream; we must pass that through."""
    merged = {
        "domain": "xyz.com",
        "sld": "xyz",
        "tld": ".com",
        "sld_length": 3,
        "observed_date": "2026-05-29",
        "zipf_score": None,
        "sources": ["namecheap_bin"],
        "prices": {"namecheap_bin": 50.0},
    }
    row = sw.merged_to_universe_row(merged)
    assert row["zipf_score"] is None


# ---------- upsert ----------

def test_upsert_returns_skipped_when_env_not_set(monkeypatch):
    monkeypatch.delenv("SUPABASE_NAMING_URL", raising=False)
    monkeypatch.delenv("SUPABASE_NAMING_SERVICE_KEY", raising=False)
    stats = sw.upsert([{"domain": "x.com"}])
    assert stats["status"] == "skipped"
    assert stats["rows_sent"] == 0


def test_upsert_batches_and_calls_rpc(monkeypatch):
    """With creds set, each batch should fire one rpc('upsert_universe_rows').

    We mock _client_or_none rather than supabase.create_client so the test
    doesn't depend on the supabase package being importable in the test
    environment (it's a runtime dep that GitHub Actions has but local
    sandboxes sometimes don't).
    """
    fake_client = MagicMock()
    fake_client.rpc.return_value.execute.return_value = MagicMock()
    monkeypatch.setattr(sw, "_client_or_none", lambda: fake_client)

    # 2,500 rows → 3 batches at default BATCH_SIZE=1000
    merged = [
        {
            "domain": f"d{i}.com",
            "sld": f"d{i}",
            "tld": ".com",
            "sld_length": len(f"d{i}"),
            "observed_date": "2026-05-29",
            "zipf_score": None,
            "sources": ["afternic"],
            "prices": {"afternic": float(i)},
        }
        for i in range(2500)
    ]
    stats = sw.upsert(merged)

    assert stats["status"] == "ok"
    assert stats["rows_sent"] == 2500
    assert stats["batches"] == 3
    # Verify the RPC was called 3 times with the right function name
    assert fake_client.rpc.call_count == 3
    for call in fake_client.rpc.call_args_list:
        args, _ = call
        assert args[0] == "upsert_universe_rows"
