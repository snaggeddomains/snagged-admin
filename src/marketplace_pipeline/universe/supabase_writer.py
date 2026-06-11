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
import time
from typing import Any

# 1K rows/batch is the size proven (by sedo_dump) to stay under Postgres's ~8s
# statement_timeout for the upsert_universe_rows merge RPC (array_agg DISTINCT,
# LEAST, CASE). The old 5K batches intermittently 57014-timed-out under load —
# the failure that disabled universe_sync and broke afternic/namecheap_bin.
# Override via env for smoke runs.
BATCH_SIZE = int(os.environ.get("UNIVERSE_UPSERT_BATCH") or 1_000)

# The merge RPC hits two load-induced, idempotent-safe transient errors:
#   57014 statement timeout  — a batch ran past the statement_timeout
#   40P01 deadlock detected  — concurrent source runs (e.g. afternic +
#                              namecheap) lock overlapping rows in opposite
#                              orders and deadlock.
# Both are safe to retry (the RPC is idempotent). Retry with exponential
# backoff before giving up, instead of failing the whole scheduled run.
UPSERT_RETRIES = 5
UPSERT_BACKOFF_BASE = 2.0  # seconds; doubles each attempt


def _is_transient(err: str) -> bool:
    low = err.lower()
    return (
        # Postgres transient errors
        "57014" in low
        or "40p01" in low
        or "deadlock" in low
        or "statement timeout" in low
        or "canceling statement" in low
        # Network / TLS transport drops — common on the long (~1h, hundreds of
        # batches) afternic upsert when Supabase briefly drops the connection.
        # These re-raised uncaught before and failed the whole source.
        or "eof occurred in violation of protocol" in low
        or "server disconnected" in low
        or "connection reset" in low
        or "connection aborted" in low
        or "broken pipe" in low
        or "writeerror" in low
        or "readerror" in low
        or "remoteprotocolerror" in low
        # HTTP/2 GOAWAY mid-upsert: the supabase client uses an HTTP/2 connection
        # and on the hour-long afternic upsert PostgREST eventually sends a GOAWAY
        # ("ConnectionTerminated error_code:0"). httpx raises RemoteProtocolError,
        # but str(e) is just "<ConnectionTerminated …>" — it has NONE of the
        # substrings above (the class name isn't in the message), so this used to
        # escape the retry and fail afternic every night. Match the message text
        # directly; the call site also feeds in the exception class name now.
        or "connectionterminated" in low
        or "connection terminated" in low
        or "goaway" in low
        or "connecterror" in low
        or "connecttimeout" in low
        or "readtimeout" in low
        or "pooltimeout" in low
        or "_ssl.c" in low
        or "timed out" in low
        or "temporarily unavailable" in low
    )


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
    from ..filters.universe import classify_dict_word, count_syllables, quality_zipf

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

    # Quality + deal scoring use the EFFECTIVE zipf (quality_zipf), which recovers a
    # real score for two-word names — the raw whole-SLD zipf is ~0 for those, so
    # scoring on it wrongly buried every compound (and .xyz/.dev) at 0.0. The stored
    # `zipf_score` column below stays the RAW value (deal queries / search rely on it).
    # Null when the name isn't scoreable (non-dict) or price is missing — keeps
    # ranking queries honest instead of treating zero as a valid signal.
    weight = scoring.tld_weight(tld)
    qzipf = quality_zipf(sld, zipf)
    quality = round(scoring.quality_score(qzipf, weight), 2) if qzipf else None
    deal = (
        int(round(scoring.deal_score(qzipf, best_price, weight)))
        if qzipf and best_price is not None and best_price > 0
        else None
    )

    return {
        "domain": merged["domain"],
        "sld": sld,
        # Store the bare TLD ("com", not ".com") — standardized across the DBs so
        # filters/joins don't have to reconcile two conventions. (tld_weight above
        # still uses the dotted form it's keyed on.)
        "tld": (tld or "").lstrip("."),
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
        "source_tier": merged.get("source_tier", 2),
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

    # Quality floor on INGEST — only names scoring >= UNIVERSE_MIN_QUALITY enter the
    # universe (default 1.0). With the corrected quality_zipf this drops almost
    # nothing the universe filter already passes (a clean dict word scores >= ~1.3
    # even on the lowest-weighted allowed TLD), so it's a guardrail rather than a
    # cull: it keeps out un-scoreable rows (non-dict / un-weighted TLD / a source
    # that forgot to filter) so the corpus the naming exercise + enrichment read
    # stays "worthwhile names". Set UNIVERSE_MIN_QUALITY=0 to disable.
    min_quality = float(os.environ.get("UNIVERSE_MIN_QUALITY") or 1.0)
    rows_below_quality = 0
    if min_quality > 0:
        kept = [r for r in wire_rows if (r.get("quality_score") or 0) >= min_quality]
        rows_below_quality = len(wire_rows) - len(kept)
        wire_rows = kept

    # Sort by the conflict key (domain) so concurrent source runs acquire row
    # locks in a consistent order — the standard mitigation for the 40P01
    # deadlocks seen when two sources upsert overlapping rows at the same time.
    wire_rows.sort(key=lambda r: r["domain"])
    sent = 0
    batches = 0
    rows_new = 0  # genuinely net-new domains (not already in name_universe)
    for i in range(0, len(wire_rows), BATCH_SIZE):
        batch = wire_rows[i : i + BATCH_SIZE]
        # Net-new accounting (for the dashboard's "new today"): count how many of
        # this batch's domains DON'T already exist, BEFORE upserting. Batches are
        # disjoint by domain (sorted + sliced), so this reflects pre-run state.
        # Sub-chunked to keep the `in.(...)` URL small; non-fatal — a metric must
        # never break the write. `rows_sent` stays the total upserted.
        batch_domains = [r["domain"] for r in batch]
        existing = 0
        for j in range(0, len(batch_domains), 200):
            sub = batch_domains[j : j + 200]
            try:
                resp = client.table("name_universe").select("domain").in_("domain", sub).execute()
                existing += len(resp.data or [])
            except Exception as e:  # noqa: BLE001 — metric only, never fatal
                print(f"      net-new count skipped for a sub-chunk: {e}")
                existing += len(sub)  # assume existing → undercount new, never overcount
        rows_new += len(batch_domains) - existing
        # The RPC takes a jsonb input named 'rows'. Retry transient Postgres
        # errors (timeout / deadlock) with backoff — the RPC is idempotent.
        for attempt in range(UPSERT_RETRIES):
            try:
                client.rpc("upsert_universe_rows", {"rows": batch}).execute()
                break
            except Exception as e:  # noqa: BLE001 — Postgres transient errors
                # Include the exception CLASS NAME in the haystack — httpx errors
                # like RemoteProtocolError carry the useful detail in the class,
                # not str(e), so matching on the message alone misses them.
                err_text = f"{type(e).__name__}: {e}"
                if attempt < UPSERT_RETRIES - 1 and _is_transient(err_text):
                    # CRITICAL for the long afternic upsert: rebuild the client so
                    # the retry doesn't reuse a GOAWAY'd / poisoned HTTP/2 connection.
                    # PostgREST terminates the long-lived connection; the supabase
                    # client otherwise keeps the dead connection in its pool, so
                    # EVERY subsequent batch's first attempt fails the same way and
                    # eats a backoff → a ~2s-per-batch crawl that timed the job out.
                    # A fresh client (reassigned here) carries forward to the next
                    # batches, so GOAWAYs recur only per server connection-limit, not
                    # every batch. Connection drops need no long backoff.
                    fresh = _client_or_none()
                    if fresh is not None:
                        client = fresh
                    backoff = UPSERT_BACKOFF_BASE * (2 ** attempt)
                    print(
                        f"      universe upsert transient error "
                        f"(batch {batches + 1}, attempt {attempt + 1}); "
                        f"rebuilt client, backing off {backoff:.0f}s",
                        flush=True,
                    )
                    time.sleep(backoff)
                    continue
                raise
        sent += len(batch)
        batches += 1
    return {
        "status": "ok",
        "rows_sent": sent,
        "rows_new": rows_new,
        "rows_below_quality": rows_below_quality,
        "batches": batches,
    }


def upsert_from_source(
    source_id: str,
    listings: list[dict[str, Any]],
    observed_date: str,
    source_tier: int = 2,
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

    `source_tier` is the playbook's source priority:
      - 1: owned / near-owned inventory (Rob, Snagged, Snagged Marketplace,
           Oxley). Naming queries search tier-1 FIRST per playbook §4.1.
      - 2: broad market (Afternic, Atom, Namecheap, etc.). Default.
    The RPC's merge logic takes LEAST(existing_tier, incoming_tier) so a
    domain that's both owned AND on the open market correctly inherits
    tier=1.

    Returns the same stats dict as upsert() plus an `input_count`.
    """
    from ..filters import standard as flt

    # Dedupe by domain within a single source's payload. Postgres's
    # ON CONFLICT DO UPDATE can't affect the same row twice in one
    # statement, so duplicates in the source data (Braden's sheet had
    # several) make the whole batch fail with code 21000. Take the
    # first occurrence per domain — later occurrences from the same
    # source within the same run would just be redundant identical
    # upserts anyway.
    seen_domains: set[str] = set()
    merged_rows: list[dict[str, Any]] = []
    duplicates_dropped = 0
    for L in listings:
        domain = (L.get("domain") or "").strip().lower()
        if not domain:
            continue
        if domain in seen_domains:
            duplicates_dropped += 1
            continue
        seen_domains.add(domain)
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
            "source_tier": source_tier,
        })

    stats = upsert(merged_rows)
    stats["input_count"] = len(listings)
    stats["normalized_count"] = len(merged_rows)
    stats["duplicates_dropped"] = duplicates_dropped
    return stats
