"""Name universe storage: Parquet partitions on Cloudflare R2, queried via DuckDB.

Layout in the R2 bucket:
    observations/source=<source>/date=<YYYY-MM-DD>.parquet  -- per-day per-source
    universe/current.parquet                                -- deduped current state

Each pipeline run upserts the day's observations into a per-source partition
and rebuilds universe/current.parquet via a DuckDB merge query.

Implementation lands after R2 credentials are in place.
"""
from __future__ import annotations

import os
from typing import Any


def _config() -> dict[str, str]:
    return {
        "access_key": os.environ.get("R2_ACCESS_KEY_ID", ""),
        "secret_key": os.environ.get("R2_SECRET_ACCESS_KEY", ""),
        "bucket": os.environ.get("R2_BUCKET", "snagged-names"),
        "endpoint": os.environ.get("R2_ENDPOINT", ""),
    }


def upsert_observations(*, source: str, report_date: str, items: list[dict[str, Any]]) -> None:
    """Append a day's listings to the source's parquet partition on R2 and
    rebuild the deduped current universe."""
    raise NotImplementedError("Name universe stub — lands after R2 setup")


def query(sql: str) -> list[dict[str, Any]]:
    """Run an arbitrary DuckDB query against the universe parquet files.

    Used by the dashboard's name-browser and by ad-hoc analyses.
    """
    raise NotImplementedError("Name universe stub — lands after R2 setup")
