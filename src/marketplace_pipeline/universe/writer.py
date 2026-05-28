"""Write a deduped, universe-filtered set of observations to Parquet.

Schema (Parquet columns):
  domain          str    primary key
  sld             str
  tld             str
  sld_length      int
  has_digits      bool   (always False because the universe filter rejects digits)
  has_hyphens     bool   (always False because the filter rejects hyphens)
  sources         list[str]   the source_ids that observed this domain today
  observed_date   str    YYYY-MM-DD of this snapshot
  zipf_score      float  optional
  prices          map[str, float]   per-source latest observed price (or null)

This is a v1 design — the full multi-day name universe is intentionally a
separate, future feature (DuckDB will union multiple per-day Parquets at
query time). For now we write one per-day file representing 'all currently-
known names observed across all sources today'.

Storage: writes to a local Parquet file path (caller chooses). If R2 env
vars are set, also uploads to s3://<R2_BUCKET>/observations/date=<date>.parquet
via DuckDB's native httpfs/S3 integration.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..filters import standard as flt
from ..filters import universe as univ


def normalize_listing(
    source_id: str,
    listing: dict[str, Any],
    observed_date: str,
) -> dict[str, Any] | None:
    """Convert a producer-snapshot dict into the universe row schema.
    Returns None if the listing doesn't pass the universe filter.
    """
    domain = (listing.get("domain") or "").strip().lower()
    if not domain or not univ.passes_universe_filter(domain):
        return None
    sld, tld = flt.extract_sld_tld(domain)
    return {
        "domain": domain,
        "sld": sld,
        "tld": tld,
        "sld_length": len(sld),
        "source": source_id,
        "observed_date": observed_date,
        "price": (
            float(listing["price"])
            if listing.get("price") is not None and listing.get("price") != ""
            else None
        ),
        "zipf_score": float(flt.freq(sld)) if sld.isalpha() else None,
    }


def merge_observations(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse multiple per-source rows for the same domain into one row
    with a sources list and a per-source price map."""
    by_domain: dict[str, dict[str, Any]] = {}
    for r in rows:
        d = r["domain"]
        entry = by_domain.get(d)
        if entry is None:
            entry = {
                "domain": d,
                "sld": r["sld"],
                "tld": r["tld"],
                "sld_length": r["sld_length"],
                "observed_date": r["observed_date"],
                "zipf_score": r["zipf_score"],
                "sources": [],
                "prices": {},
            }
            by_domain[d] = entry
        if r["source"] not in entry["sources"]:
            entry["sources"].append(r["source"])
        if r["price"] is not None:
            entry["prices"][r["source"]] = r["price"]
    return list(by_domain.values())


def write_parquet(rows: list[dict[str, Any]], output_path: Path) -> int:
    """Write a list of merged rows to a Parquet file. Returns the row count."""
    import duckdb

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        # Write an empty file with the expected schema so downstream tools
        # can still LIST it without special-casing 'no observations today'.
        con = duckdb.connect(":memory:")
        con.execute(
            """
            CREATE TABLE listings (
                domain VARCHAR,
                sld VARCHAR,
                tld VARCHAR,
                sld_length INTEGER,
                observed_date VARCHAR,
                zipf_score DOUBLE,
                sources VARCHAR[],
                prices MAP(VARCHAR, DOUBLE)
            )
            """
        )
        con.execute(f"COPY listings TO '{output_path}' (FORMAT PARQUET)")
        return 0

    # DuckDB can't register a raw list[dict]; round-trip via pyarrow Table
    # (which DuckDB bundles natively).
    import pyarrow as pa

    table = pa.Table.from_pylist(rows)
    con = duckdb.connect(":memory:")
    con.register("incoming", table)
    con.execute(f"COPY incoming TO '{output_path}' (FORMAT PARQUET)")
    return len(rows)


def upload_to_r2(local_path: Path, *, observed_date: str) -> str | None:
    """Upload to R2 if env vars are set, return the s3:// URL. Otherwise None."""
    access_key = os.environ.get("R2_ACCESS_KEY_ID")
    secret_key = os.environ.get("R2_SECRET_ACCESS_KEY")
    bucket = os.environ.get("R2_BUCKET")
    endpoint = os.environ.get("R2_ENDPOINT")
    if not all([access_key, secret_key, bucket, endpoint]):
        return None

    import duckdb

    target = f"s3://{bucket}/observations/date={observed_date}.parquet"
    con = duckdb.connect(":memory:")
    con.execute("INSTALL httpfs;")
    con.execute("LOAD httpfs;")
    con.execute(f"SET s3_access_key_id='{access_key}';")
    con.execute(f"SET s3_secret_access_key='{secret_key}';")
    # R2 endpoint without scheme; DuckDB adds https
    cleaned_endpoint = endpoint.replace("https://", "").replace("http://", "")
    con.execute(f"SET s3_endpoint='{cleaned_endpoint}';")
    con.execute("SET s3_url_style='path';")
    con.execute(
        f"COPY (SELECT * FROM '{local_path}') TO '{target}' (FORMAT PARQUET)"
    )
    return target
