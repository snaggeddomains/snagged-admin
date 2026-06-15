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

import array
import gzip
import hashlib
import os
from datetime import datetime, timezone
from typing import Iterable

# Persist the fingerprint in the naming project's Supabase Storage — the same
# project + service key the upserts already use (no extra infra/secrets, unlike
# R2 which isn't configured). ~6.5M hashes ≈ 52 MB, which exceeds Supabase's
# default 50 MB per-file limit, so it's SHARDED into SHARDS gzipped int64 arrays
# at fingerprints/<source>.<i>.bin.gz (~13 MB each at 4 shards).
BUCKET = os.environ.get("UNIVERSE_FINGERPRINT_BUCKET") or "pipeline-fingerprints"
SHARDS = max(1, int(os.environ.get("UNIVERSE_FINGERPRINT_SHARDS") or 4))


# 63-bit so it always fits a signed int64 ("q"). Collision probability at ~6.5M
# items in a 2^63 space is ~10^-6; a collision only risks skipping one changed
# row, which the weekly full re-affirm pass then corrects.
def row_hash(domain: str, price) -> int:
    p = "" if price is None else f"{float(price):.2f}"
    digest = hashlib.blake2b(f"{domain}|{p}".encode("utf-8"), digest_size=8).digest()
    return int.from_bytes(digest, "big") & 0x7FFF_FFFF_FFFF_FFFF


def _sb_env() -> tuple[str, str] | None:
    url = os.environ.get("SUPABASE_NAMING_URL")
    key = os.environ.get("SUPABASE_NAMING_SERVICE_KEY")
    if not (url and key):
        return None
    return url.rstrip("/"), key


def _shard_url(base: str, source_id: str, i: int) -> str:
    return f"{base}/storage/v1/object/{BUCKET}/fingerprints/{source_id}.{i}.bin.gz"


def _ensure_bucket(base: str, key: str) -> None:
    import requests

    try:
        r = requests.post(
            f"{base}/storage/v1/bucket",
            headers={"Authorization": f"Bearer {key}", "apikey": key, "Content-Type": "application/json"},
            json={"id": BUCKET, "name": BUCKET, "public": False},  # default file-size limit
            timeout=30,
        )
        if r.status_code not in (200, 201, 409):  # 409 = already exists
            print(f"      fingerprint bucket create HTTP {r.status_code}: {r.text[:160]}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"      fingerprint bucket ensure error: {e}", flush=True)


def load_fingerprint(source_id: str) -> set[int]:
    """Prior run's hash set from Supabase Storage (all shards unioned). Empty set
    when unconfigured, absent, or only partially present (→ the caller does a full
    upsert and re-seeds)."""
    env = _sb_env()
    if not env:
        return set()
    base, key = env
    import requests

    out: set[int] = set()
    try:
        for i in range(SHARDS):
            r = requests.get(_shard_url(base, source_id, i),
                             headers={"Authorization": f"Bearer {key}", "apikey": key}, timeout=180)
            if r.status_code != 200 or not r.content:
                print(f"      fingerprint load: shard {i}/{SHARDS} missing (HTTP {r.status_code}) → treating as no prior", flush=True)
                return set()
            a = array.array("q")
            a.frombytes(gzip.decompress(r.content))
            out.update(a)
        return out
    except Exception as e:  # noqa: BLE001 — transient / corrupt → treat as no prior
        print(f"      fingerprint load skipped ({source_id}): {e}", flush=True)
        return set()


def save_fingerprint(source_id: str, hashes: Iterable[int]) -> bool:
    """Snapshot the current run's hash set to Supabase Storage, sharded into
    SHARDS gzipped int64 blobs. No-op when the naming Supabase isn't configured."""
    env = _sb_env()
    if not env:
        return False
    base, key = env
    import requests

    _ensure_bucket(base, key)
    shards: list[list[int]] = [[] for _ in range(SHARDS)]
    for h in hashes:
        shards[h % SHARDS].append(h)
    ok = True
    for i, part in enumerate(shards):
        blob = gzip.compress(array.array("q", part).tobytes(), compresslevel=6)
        r = requests.post(
            _shard_url(base, source_id, i),
            headers={
                "Authorization": f"Bearer {key}", "apikey": key,
                "Content-Type": "application/octet-stream", "x-upsert": "true",
            },
            data=blob, timeout=300,
        )
        if r.status_code not in (200, 201):
            print(f"      fingerprint save shard {i} HTTP {r.status_code}: {r.text[:160]}", flush=True)
            ok = False
    return ok


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
