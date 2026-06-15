"""Delta-upsert fingerprints for the name_universe writers.

A full marketplace feed (afternic ~6.2M qualifying rows) re-upserts every row to
`name_universe` every night, even though ~99% are byte-identical to yesterday.
That full rewrite is what makes afternic take ~1-2h and flirt with the job
timeout. The fix: remember what we sent last time and only upsert NEW or CHANGED
rows.

"What we sent" is captured as a set of stable 64-bit hashes of ``domain|price``
(price is the only feed input that changes the stored row — it drives best_price
+ the quality/deal scores). A row is CHANGED when its hash isn't in the prior
set (new domain, or a price move). The set is snapshotted to R2 as a one-column
parquet (``fingerprints/<source>.parquet``), reusing the same DuckDB + httpfs +
R2 path as ``writer.upload_to_r2`` — no new dependency, no key in code.

Gated by ``UNIVERSE_DELTA=1`` (off → byte-for-byte the old full-rewrite
behavior, no R2 reads/writes). First run (no prior fingerprint) = full upsert
that just seeds the fingerprint, so it self-bootstraps. ``observed_date`` on a
skipped row stops advancing, so a weekly FULL pass re-affirms it (Sundays, or
``UNIVERSE_DELTA_FULL=1``).
"""
from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from typing import Any, Iterable


# 63-bit so it always fits a signed parquet/DuckDB BIGINT. Collision probability
# at 6.2M items in a 2^63 space is ~10^-6; a collision only risks skipping one
# changed row, which the weekly full re-affirm pass then corrects.
def row_hash(domain: str, price: Any) -> int:
    p = "" if price is None else f"{float(price):.2f}"
    digest = hashlib.blake2b(f"{domain}|{p}".encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") & 0x7FFF_FFFF_FFFF_FFFF


def _r2_env() -> dict[str, str] | None:
    keys = ("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_ENDPOINT")
    vals = {k: os.environ.get(k) for k in keys}
    if not all(vals.values()):
        return None
    return vals  # type: ignore[return-value]


def _duck(r2: dict[str, str]):
    import duckdb

    con = duckdb.connect(":memory:")
    con.execute("INSTALL httpfs;")
    con.execute("LOAD httpfs;")
    con.execute(f"SET s3_access_key_id='{r2['R2_ACCESS_KEY_ID']}';")
    con.execute(f"SET s3_secret_access_key='{r2['R2_SECRET_ACCESS_KEY']}';")
    endpoint = r2["R2_ENDPOINT"].replace("https://", "").replace("http://", "")
    con.execute(f"SET s3_endpoint='{endpoint}';")
    con.execute("SET s3_url_style='path';")
    return con


def _target(r2: dict[str, str], source_id: str) -> str:
    return f"s3://{r2['R2_BUCKET']}/fingerprints/{source_id}.parquet"


def load_fingerprint(source_id: str) -> set[int]:
    """Prior run's hash set from R2. Empty set when unconfigured or absent (→ the
    caller does a full upsert and seeds it)."""
    r2 = _r2_env()
    if not r2:
        return set()
    try:
        con = _duck(r2)
        tbl = con.execute(f"SELECT h FROM '{_target(r2, source_id)}'").fetch_arrow_table()
        return set(tbl.column("h").to_pylist())
    except Exception as e:  # noqa: BLE001 — missing object / transient → treat as no prior
        print(f"      fingerprint load skipped ({source_id}): {e}", flush=True)
        return set()


def save_fingerprint(source_id: str, hashes: Iterable[int]) -> bool:
    """Snapshot the current run's hash set to R2 (one-column parquet). No-op when
    R2 isn't configured."""
    r2 = _r2_env()
    if not r2:
        return False
    import pyarrow as pa

    tbl = pa.table({"h": pa.array(list(hashes), type=pa.int64())})
    con = _duck(r2)
    con.register("fp", tbl)
    con.execute(f"COPY (SELECT h FROM fp) TO '{_target(r2, source_id)}' (FORMAT PARQUET)")
    return True


def _is_weekly_full(now: datetime | None = None) -> bool:
    # Sunday (UTC) → full re-affirm so skipped rows' observed_date doesn't go stale.
    return (now or datetime.now(timezone.utc)).weekday() == 6


class DeltaFilter:
    """Tracks which feed rows actually need upserting.

    Usage in a streaming source:
        delta = DeltaFilter(SOURCE_ID)
        ...
        if delta.keep(domain, price):
            buffer.append(row)        # upsert only kept rows
        ...
        delta.commit()               # snapshot the new fingerprint

    When disabled (``UNIVERSE_DELTA`` != "1") ``keep`` is always True and nothing
    touches R2 — identical to the old full-rewrite path.
    """

    def __init__(self, source_id: str, *, enabled: bool | None = None, force_full: bool | None = None):
        self.source_id = source_id
        self.enabled = (os.environ.get("UNIVERSE_DELTA") == "1") if enabled is None else enabled
        env_full = os.environ.get("UNIVERSE_DELTA_FULL") == "1"
        self.force_full = (env_full or _is_weekly_full()) if force_full is None else force_full
        # Skip the prior load entirely on a forced full pass — everything upserts.
        self.prior: set[int] = load_fingerprint(source_id) if (self.enabled and not self.force_full) else set()
        self.current: set[int] = set()
        self.skipped = 0
        self.kept = 0

    def keep(self, domain: str, price: Any) -> bool:
        if not self.enabled:
            return True
        h = row_hash(domain, price)
        self.current.add(h)
        if h in self.prior:
            self.skipped += 1
            return False
        self.kept += 1
        return True

    def commit(self) -> None:
        if not self.enabled:
            return
        try:
            ok = save_fingerprint(self.source_id, self.current)
            mode = "FULL re-affirm" if self.force_full else "delta"
            print(
                f"      universe {mode}: {self.kept:,} upserted, {self.skipped:,} unchanged-skipped, "
                f"fingerprint {'saved' if ok else 'NOT saved (R2 unconfigured)'} "
                f"({len(self.current):,} rows)",
                flush=True,
            )
        except Exception as e:  # noqa: BLE001 — never fail the run on a fingerprint write
            print(f"      fingerprint save FAILED ({self.source_id}); next run re-upserts all: {e}", flush=True)
