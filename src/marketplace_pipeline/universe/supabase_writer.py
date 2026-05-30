"""Bulk upsert into the snagged-naming-universe Supabase `name_universe`
table.

Calls the `upsert_universe_rows(jsonb)` RPC function on the server side
so the merge semantics (preserve `first_seen`, replace today's snapshot
for everything else) happen in a single SQL statement per batch instead
of N round-trips.

Read SUPABASE_NAMING_URL + SUPABASE_NAMING_SERVICE_KEY from env. If
either is missing, the upsert is skipped with a clear message — this
lets local development still write Parquet without needing Supabase
credentials.
"""
from __future__ import annotations

import os
from typing import Any

BATCH_SIZE = 1_000


def _client_or_none():
    url = os.environ.get("SUPABASE_NAMING_URL")
    key = os.environ.get("SUPABASE_NAMING_SERVICE_KEY")
    if not (url and key):
        return None
    from supabase import create_client

    return create_client(url, key)


def merged_to_universe_row(merged: dict[str, Any]) -> dict[str, Any]:
    """Convert a writer.merge_observations() row into the wire format
    expected by the upsert_universe_rows RPC.

    The RPC's input schema collapses the per-source price map into a
    single (best_price, best_price_source) pair — we don't store the
    full map server-side, only the cheapest current observation.

    Cheap deterministic enrichment fields computed here at ingest time so
    they're indexable in Postgres without per-query LLM/wordfreq calls:
      - num_words, num_syllables, is_dictionary_word (structural)
      - quality_score = zipf * tld_weight (bounded ~0-7)
      - deal_score    = (zipf * tld_weight) / price * 10000, rounded to int
        (typical range 1-1000 — reads as a clean integer in sheets / UI)

    Expensive LLM-based fields (category, emotions, keywords, industries)
    are populated separately by a Phase 2 enrichment worker.
    """
    from .. import scoring
    from ..filters.universe import classify_dict_word, count_syllables

    prices: dict[str, float] = merged.get("prices") or {}
    if prices:
        best_source, best_price = min(prices.items(), key=lambda kv: kv[1])
    else:
        best_source, best_price = None, None

    sld = merged["sld"]
    tld = merged["tld"]
    zipf = merged.get("zipf_score")

    num_words = classify_dict_word(sld)  # 1, 2, or None (rare since only
    # universe-filter-passing rows reach here, but defend anyway)

    # Quality + deal scoring. Null when zipf or price is missing — keeps
    # ranking queries honest instead of treating zero as a valid signal.
    weight = scoring.tld_weight(tld)
    quality = round(scoring.quality_score(zipf, weight), 2) if zipf is not None else None
    deal = (
        int(round(scoring.deal_score(zipf, best_price, weight)))
        if zipf is not None and best_price is not None and best_price > 0
        else None
    )

    return {
        "domain": merged["domain"],
        "sld": sld,
        "tld": tld,
        "sld_length": int(merged["sld_length"]),
        "zipf_score": zipf,
        "observed_date": merged["observed_date"],
        "sources": list(merged.get("sources") or []),
        "best_price": best_price,
        "best_price_source": best_source,
        "num_words": num_words,
        "num_syllables": count_syllables(sld),
        "is_dictionary_word": num_words == 1 if num_words is not None else None,
        "quality_score": quality,
        "deal_score": deal,
    }


def upsert(merged_rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Upsert merged universe rows into Supabase. Returns a stats dict.

    No-op (with a `skipped` status) when credentials aren't configured —
    `universe-sync` should keep working for local dry-runs and Parquet
    writes without Supabase set up.
    """
    client = _client_or_none()
    if client is None:
        return {
            "status": "skipped",
            "reason": "SUPABASE_NAMING_URL / SUPABASE_NAMING_SERVICE_KEY not set",
            "rows_sent": 0,
            "batches": 0,
        }

    wire_rows = [merged_to_universe_row(r) for r in merged_rows]
    sent = 0
    batches = 0
    for i in range(0, len(wire_rows), BATCH_SIZE):
        batch = wire_rows[i : i + BATCH_SIZE]
        # The RPC takes a jsonb input named 'rows'.
        client.rpc("upsert_universe_rows", {"rows": batch}).execute()
        sent += len(batch)
        batches += 1
    return {
        "status": "ok",
        "rows_sent": sent,
        "batches": batches,
    }


def upsert_from_source(
    source_id: str,
    listings: list[dict[str, Any]],
    observed_date: str,
) -> dict[str, Any]:
    """Bulk upsert universe rows directly from a single source's run.

    Input shape (what sources have in hand after their universe filter):
        [{"domain": "table.com", "price": 99.0}, ...]

    Each listing is normalized into the merged-row shape (computing
    sld/tld/sld_length, looking up zipf, etc.) and bulk-upserted via
    the RPC. Used by source modules to land their universe data
    directly into Supabase instead of going through giant local
    universe_snapshot.json files + a separate universe-sync workflow
    (which fails at scale: Afternic's snapshot is ~360 MB).

    Returns the same stats dict as upsert() plus an `input_count`.
    """
    from ..filters import standard as flt

    merged_rows: list[dict[str, Any]] = []
    for L in listings:
        domain = (L.get("domain") or "").strip().lower()
        if not domain:
            continue
        sld, tld = flt.extract_sld_tld(domain)
        if not sld:
            continue
        price = L.get("price")
        prices = {source_id: float(price)} if price is not None else {}
        merged_rows.append({
            "domain": domain,
            "sld": sld,
            "tld": tld,
            "sld_length": len(sld),
            "observed_date": observed_date,
            "zipf_score": float(flt.freq(sld)) if sld.isalpha() else None,
            "sources": [source_id],
            "prices": prices,
        })

    stats = upsert(merged_rows)
    stats["input_count"] = len(listings)
    stats["normalized_count"] = len(merged_rows)
    return stats
