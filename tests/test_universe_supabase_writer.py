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


def test_merged_to_universe_row_computes_quality_and_deal_scores():
    """quality_score = zipf * tld_weight (2 decimals, ~0-7 range).
    deal_score = (zipf * tld_weight) / price * 10000, rounded to integer
    so it reads cleanly in sheets (typical range 1-1000)."""
    # .com (weight 1.0), zipf 5.0, price $50 → quality 5.0, deal 1000
    row = sw.merged_to_universe_row({
        "domain": "table.com", "sld": "table", "tld": ".com",
        "sld_length": 5, "observed_date": "2026-05-29",
        "zipf_score": 5.0, "sources": ["afternic"],
        "prices": {"afternic": 50.0},
    })
    assert row["quality_score"] == 5.0
    assert row["deal_score"] == 1000
    assert isinstance(row["deal_score"], int)

    # .org (weight 0.6), zipf 4.0, price $200 → quality 2.4, deal 120
    row2 = sw.merged_to_universe_row({
        "domain": "ocean.org", "sld": "ocean", "tld": ".org",
        "sld_length": 5, "observed_date": "2026-05-29",
        "zipf_score": 4.0, "sources": ["namecheap_bin"],
        "prices": {"namecheap_bin": 200.0},
    })
    assert row2["quality_score"] == 2.4
    assert row2["deal_score"] == 120


def test_two_word_names_get_a_real_quality_score():
    """Regression: a two-word concatenation has a whole-SLD zipf ~0, but both
    halves are real words — quality_zipf recovers a real score so the name isn't
    wrongly buried at 0.0 (which would also leave it permanently un-enriched)."""
    row = sw.merged_to_universe_row({
        "domain": "lunchmoney.com", "sld": "lunchmoney", "tld": ".com",
        "sld_length": 10, "observed_date": "2026-05-29",
        "zipf_score": 0.0,  # whole-string zipf is ~0 for a compound
        "sources": ["atom_daily"], "prices": {},
    })
    assert row["num_words"] == 2
    # Scored on the weaker half (lunch/money are both common) → comfortably > 1.
    assert row["quality_score"] is not None and row["quality_score"] > 1.0


def test_xyz_and_dev_single_words_score_above_zero():
    """.xyz / .dev are allowed TLDs; they must carry a weight or every name on
    them scores 0.0. A single dictionary word on .xyz should score > 1."""
    row = sw.merged_to_universe_row({
        "domain": "ignore.xyz", "sld": "ignore", "tld": ".xyz",
        "sld_length": 6, "observed_date": "2026-05-29",
        "zipf_score": 4.0, "sources": ["namecheap_bin"], "prices": {},
    })
    assert row["quality_score"] is not None and row["quality_score"] > 1.0


def test_merged_to_universe_row_nullifies_scores_when_inputs_missing():
    """If zipf or price is unknown, quality / deal should be NULL so
    ranking queries don't conflate 'missing' with 'bad'."""
    row = sw.merged_to_universe_row({
        "domain": "xyz.com", "sld": "xyz", "tld": ".com",
        "sld_length": 3, "observed_date": "2026-05-29",
        "zipf_score": None,  # non-alpha SLD
        "sources": ["namecheap_bin"],
        "prices": {"namecheap_bin": 100.0},
    })
    assert row["quality_score"] is None
    assert row["deal_score"] is None

    row2 = sw.merged_to_universe_row({
        "domain": "table.com", "sld": "table", "tld": ".com",
        "sld_length": 5, "observed_date": "2026-05-29",
        "zipf_score": 5.0,
        "sources": ["afternic"],
        "prices": {},  # no price
    })
    assert row2["quality_score"] == 5.0  # still has zipf+weight
    assert row2["deal_score"] is None  # but no price → no deal score


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


# ---------- transient-error classification ----------

def test_is_transient_matches_http2_goaway():
    """Regression: the HTTP/2 GOAWAY that fails the nightly afternic upsert.
    str() of httpx.RemoteProtocolError is just the ConnectionTerminated message
    (no class name), so it must match on the message text — and the call site
    also prepends the class name."""
    msg = "<ConnectionTerminated error_code:0, last_stream_id:263, additional_data:None>"
    assert sw._is_transient(msg)                       # message alone
    assert sw._is_transient(f"RemoteProtocolError: {msg}")  # with class name


def test_is_transient_ignores_genuine_errors():
    assert not sw._is_transient("ValueError: domain is required")
    assert not sw._is_transient("KeyError: 'sld'")


# ---------- upsert ----------

def test_upsert_returns_skipped_when_env_not_set(monkeypatch):
    monkeypatch.delenv("SUPABASE_NAMING_URL", raising=False)
    monkeypatch.delenv("SUPABASE_NAMING_SERVICE_KEY", raising=False)
    stats = sw.upsert([{"domain": "x.com"}])
    assert stats["status"] == "skipped"
    assert stats["rows_sent"] == 0


def test_upsert_applies_quality_floor(monkeypatch):
    """Ingest floor: only names scoring >= UNIVERSE_MIN_QUALITY (default 1.0) are
    upserted; un-scoreable rows (non-dict SLD → null quality) are dropped and
    counted in rows_below_quality."""
    fake_client = MagicMock()
    # Net-new count sub-query → pretend nothing exists yet.
    fake_client.table.return_value.select.return_value.in_.return_value.execute.return_value = MagicMock(data=[])
    monkeypatch.setattr(sw, "_client_or_none", lambda: fake_client)
    # The heavy RPC now goes over a direct HTTP/1.1 client — mock that.
    rpc = MagicMock()
    monkeypatch.setattr(sw, "_rpc_upsert_rows", rpc)
    monkeypatch.setenv("SUPABASE_NAMING_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_NAMING_SERVICE_KEY", "k")
    monkeypatch.delenv("UNIVERSE_MIN_QUALITY", raising=False)  # default 1.0

    merged = [
        # Real dictionary word → quality ~5 → kept.
        {"domain": "table.com", "sld": "table", "tld": ".com", "sld_length": 5,
         "observed_date": "2026-05-29", "zipf_score": 5.0, "sources": ["afternic"], "prices": {}},
        # Non-alpha SLD → null quality → dropped by the floor.
        {"domain": "xyz123.com", "sld": "xyz123", "tld": ".com", "sld_length": 6,
         "observed_date": "2026-05-29", "zipf_score": None, "sources": ["afternic"], "prices": {}},
    ]
    stats = sw.upsert(merged)
    assert stats["status"] == "ok"
    assert stats["rows_sent"] == 1
    assert stats["rows_below_quality"] == 1
    # The single kept row is what got sent to the RPC (3rd positional arg = batch).
    sent = rpc.call_args_list[0].args[2]
    assert [r["domain"] for r in sent] == ["table.com"]


def test_upsert_batches_and_calls_rpc(monkeypatch):
    """With creds set, each batch should fire one upsert RPC.

    We mock _client_or_none rather than supabase.create_client so the test
    doesn't depend on the supabase package being importable in the test
    environment (it's a runtime dep that GitHub Actions has but local
    sandboxes sometimes don't), and mock the HTTP/1.1 RPC helper directly.
    """
    fake_client = MagicMock()
    monkeypatch.setattr(sw, "_client_or_none", lambda: fake_client)
    rpc = MagicMock()
    monkeypatch.setattr(sw, "_rpc_upsert_rows", rpc)
    monkeypatch.setenv("SUPABASE_NAMING_URL", "https://x.supabase.co")
    monkeypatch.setenv("SUPABASE_NAMING_SERVICE_KEY", "k")
    # Disable the ingest quality floor — these synthetic rows (digit SLDs) score
    # null and the test is about batch math, not the floor (covered separately).
    monkeypatch.setenv("UNIVERSE_MIN_QUALITY", "0")

    # Batch count is derived from sw.BATCH_SIZE so this test stays correct when
    # the batch size is tuned (e.g. 1K batches for Postgres-timeout resilience).
    n_rows = 12_000
    expected_batches = -(-n_rows // sw.BATCH_SIZE)  # ceil division
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
        for i in range(n_rows)
    ]
    stats = sw.upsert(merged)

    assert stats["status"] == "ok"
    assert stats["rows_sent"] == n_rows
    assert stats["batches"] == expected_batches
    # One RPC call per batch; each carries (url, key, batch).
    assert rpc.call_count == expected_batches
    for call in rpc.call_args_list:
        assert call.args[0] == "https://x.supabase.co"
        assert isinstance(call.args[2], list)
