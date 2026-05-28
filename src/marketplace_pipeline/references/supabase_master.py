"""Supabase 'Master Domain List' — curated brand-candidate reference table.

Queried ad-hoc during naming-exercise workflows. NOT a scheduled producer.

The expected join pattern in naming queries is:
    master (Supabase) JOIN universe (R2/Parquet via DuckDB) ON domain

Master columns of interest (see sources.yaml -> references.supabase_master):
    domain, price, owner, sld_length, is_single_word, tld, syllables,
    number_of_words, dictionary_word, category, root_words, emotions,
    keywords, source, created_at, updated_at

Implementation lands when the naming-browser endpoint is built.
"""
from __future__ import annotations

import os
from typing import Any

TABLE = '"Master Domain List"'


def _client():
    from supabase import create_client

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_ANON_KEY")
    if not url or not key:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or ANON) must be set")
    return create_client(url, key)


def lookup(domain: str) -> dict[str, Any] | None:
    """Return the master-list row for `domain`, or None if absent."""
    raise NotImplementedError("supabase_master.lookup — lands with naming-browser endpoint")


def search(
    *,
    tlds: list[str] | None = None,
    sld_length: tuple[int, int] | None = None,
    is_single_word: bool | None = None,
    dictionary_word: bool | None = None,
    category: str | None = None,
    keyword_match: str | None = None,
    price_max: float | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Filter the master list by typical naming-exercise criteria.

    `keyword_match` uses the trigram index on the `keywords` column for fuzzy
    matching; falls back to ilike on root_words if needed.
    """
    raise NotImplementedError("supabase_master.search — lands with naming-browser endpoint")
