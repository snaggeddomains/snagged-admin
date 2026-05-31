"""Sedo full-marketplace dump via a partitioned crawl.

Unlike sedo_net_new (which pulls the page-1 delta of fresh listings every
12h), this source walks the *entire* reachable Sedo marketplace so the long
tail of older listings lands in the naming universe (Supabase
`name_universe`).

Why a partitioned crawl
-----------------------
Sedo's search backend caps deep pagination at the first 10,000 results of
any single query (the Elasticsearch `index.max_result_window` default),
regardless of how many documents actually matched. A 2026-05-31 probe
confirmed it: a broad query reported `hitsTotal: 263,993` but page 20 at
pagesize 500 (offset 10,000) still returned a full page while page 50
(offset 24,500) returned 0 rows AND hitsTotal 0 — the signature of an
out-of-range deep page being rejected.

So a single broad query can only ever surface 10k of ~264k. To get the
whole inventory we recursively partition the search space until every
leaf query reports `hitsTotal < 10,000`, then page that leaf to the floor
and union the results (deduping by domain). Partition dimensions, applied
in order, only splitting further when a node is still over the cap:

    TLD  ->  price band  ->  domain length  ->  word count

Pacing is deliberately conservative (~1 req/s + jitter, backoff on
429/403) — the crawl makes far more requests than the net-new probe and we
don't want a runner egress IP throttled. Requests are anonymous
(`member=""`, fresh session, spoofed browser UA); they carry no Sedo
account credentials.

No new credentials needed beyond the universe Supabase keys.
"""
from __future__ import annotations

import os
import random
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from typing import Any, Callable

import requests

from .. import config, state
from ..filters import universe as univ

SOURCE_ID = "sedo_dump"
SOURCE_LABEL = "Sedo Dump"

# ---------- fetch constants (shared with sedo_net_new) ----------

BASE_URL = "https://sedo.com/service/common.php"
SEARCH_URL = "https://sedo.com/search/"
USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36"
)

# Sedo's deep-pagination ceiling (offset, not page). See module docstring.
REACHABLE_CAP = 10_000
PAGE_SIZE = 500
MAX_PAGE = REACHABLE_CAP // PAGE_SIZE  # 20 at pagesize 500

# ---------- partition space ----------

# Default TLDs == the universe filter's allow-list (filters/universe.py
# ALLOWED_TLDS). Crawling TLDs the universe would reject is wasted
# bandwidth, so we scope the dump to exactly what name_universe ingests.
DEFAULT_TLDS: tuple[str, ...] = ("com", "net", "org", "co", "ai", "xyz", "dev")

# Price bands in USD; the last band's end=0 means "open-ended top".
# Bands may overlap at boundaries — harmless because we dedupe by domain.
PRICE_BANDS: tuple[tuple[int, int], ...] = (
    (0, 100), (100, 500), (500, 1_000),
    (1_000, 5_000), (5_000, 25_000), (25_000, 0),
)

# Domain-length buckets (len_max=0 means open-ended).
LEN_BUCKETS: tuple[tuple[int, int], ...] = (
    (1, 3), (4, 4), (5, 5), (6, 6), (7, 7), (8, 8), (9, 12), (13, 0),
)

# Word-count buckets. Default crawl is 1-2 word names — that's the
# brandable inventory the universe filter accepts (single dictionary word
# or two concatenated words); 3+ word names would be filtered out anyway.
WORD_BUCKETS: tuple[tuple[int, int], ...] = ((1, 1), (2, 2))

# Conservative pacing.
REQUEST_DELAY = 1.0      # base seconds between requests
REQUEST_JITTER = 0.5     # added uniform jitter
MAX_RETRIES = 4          # on 429 / 403 / transient network errors
BACKOFF_BASE = 4.0       # seconds; doubles each retry

# Safety valves (overridable via env for smoke runs).
DEFAULT_MAX_REQUESTS = 5_000
DEFAULT_TIME_BUDGET_SEC = 6_000  # 100 min; workflow timeout is higher

# Resilience / observability.
FLUSH_EVERY = 5_000              # upsert to Supabase every N new universe domains
CHECKPOINT_EVERY_PARTITIONS = 25  # write+push progress.json every N partitions
CHECKPOINT_EVERY_SEC = 120        # ...or at least this often

# Supabase upsert resilience. The shared `upsert_universe_rows` RPC has
# expensive merge logic (array_agg DISTINCT, LEAST, CASE) and intermittently
# exceeds Postgres's 8s statement_timeout even at 5k batches (this is the
# documented failure that disabled universe_sync). So sedo_dump upserts in
# SMALL chunks, retries on a statement timeout (transient/load-dependent),
# and treats a persistently-failing chunk as non-fatal — a later flush /
# re-run (the RPC is idempotent) catches anything skipped.
UPSERT_CHUNK = 1_000
UPSERT_RETRIES = 5
UPSERT_BACKOFF_BASE = 2.0  # seconds; doubles each retry

SNAPSHOT_FILE = "snapshot.json"  # compact summary only — never the full dump
PROGRESS_FILE = "progress.json"  # live checkpoint, pushed mid-crawl


# ---------- partition model ----------

@dataclass(frozen=True)
class Partition:
    """A constrained slice of Sedo's search space.

    `applied` records which dimensions have already been subdivided so the
    recursion knows what it may still split on.
    """
    tlds: tuple[str, ...]
    len_min: int = 1
    len_max: int = 0       # 0 = open
    words_min: int = 1
    words_max: int = 0     # 0 = open
    price_start: int = 0
    price_end: int = 0     # 0 = open
    applied: frozenset[str] = field(default_factory=frozenset)

    def label(self) -> str:
        tld = "+".join(self.tlds) if len(self.tlds) <= 3 else f"{len(self.tlds)}tlds"
        return (
            f"tld={tld} len={self.len_min}-{self.len_max or '∞'} "
            f"words={self.words_min}-{self.words_max or '∞'} "
            f"price={self.price_start}-{self.price_end or '∞'}"
        )


def _split_tld(p: Partition) -> list[Partition] | None:
    if "tld" in p.applied or len(p.tlds) <= 1:
        return None
    return [
        replace(p, tlds=(t,), applied=p.applied | {"tld"})
        for t in p.tlds
    ]


def _split_price(p: Partition) -> list[Partition] | None:
    if "price" in p.applied:
        return None
    return [
        replace(p, price_start=s, price_end=e, applied=p.applied | {"price"})
        for (s, e) in PRICE_BANDS
    ]


def _split_length(p: Partition) -> list[Partition] | None:
    if "length" in p.applied:
        return None
    return [
        replace(p, len_min=lo, len_max=hi, applied=p.applied | {"length"})
        for (lo, hi) in LEN_BUCKETS
    ]


def _split_words(p: Partition) -> list[Partition] | None:
    if "words" in p.applied:
        return None
    return [
        replace(p, words_min=lo, words_max=hi, applied=p.applied | {"words"})
        for (lo, hi) in WORD_BUCKETS
    ]


# Dimension order: TLD -> price -> length -> words.
SPLITTERS: tuple[Callable[[Partition], list[Partition] | None], ...] = (
    _split_tld, _split_price, _split_length, _split_words,
)


def subdivide(p: Partition) -> list[Partition] | None:
    """Return child partitions from the first applicable dimension, or None
    if every dimension has been exhausted (an irreducible leaf)."""
    for splitter in SPLITTERS:
        children = splitter(p)
        if children:
            return children
    return None


# ---------- HTTP ----------

def _build_payload(p: Partition, page: int, size: int) -> list[tuple[str, str | int]]:
    """Form payload matching Sedo's search backend (mirrors sedo_net_new,
    parameterized over the partition's filter fields)."""
    payload: list[tuple[str, str | int]] = [
        ("safe_search", 2),
        ("synonyms", "true"),
        ("listing_type[]", 1),
        ("listing_type[]", 2),
        ("listing_type[]", 3),
        ("listing_type[]", 5),
        ("auction_group[]", 62),
        ("auction_event", ""),
        ("price_start", p.price_start),
        ("price_end", p.price_end),
        ("price_currency", 3),
        ("traffic_start", 0),
        ("traffic_end", 0),
        ("number_of_words_min", p.words_min),
        ("number_of_words_max", p.words_max),
        ("len_min", p.len_min),
        ("len_max", p.len_max),
        ("special_characters[]", 3),
        ("special_characters[]", 1),
        ("special_characters[]", 2),
        ("cat[]", 0),
        ("cat[]", 0),
        ("cat[]", 0),
        ("type", 0),
        ("special_inventory", 4),
        ("kws", "contains"),
        ("age_min", 0),
        ("age_max", 0),
        ("keyword", ""),
        ("page", page),
        ("rel", 6),
        ("orderdirection", 2),
        ("domainIds", ""),
    ]
    for tld in p.tlds:
        payload.append(("cc[]", tld))
    payload.extend([
        ("member", ""),
        ("v", "0.1"),
        ("o", "json"),
        ("m", "search"),
        ("f", "requestSearch"),
        ("pagesize", size),
        ("keywords_join", "AND"),
        ("loadListingFeatured", "true"),
        ("language", "us"),
    ])
    return payload


class SedoFetcher:
    """Stateful Sedo search client with conservative pacing + backoff.

    Separated from the crawl loop so tests can substitute a fake."""

    def __init__(
        self,
        *,
        delay: float = REQUEST_DELAY,
        jitter: float = REQUEST_JITTER,
        max_retries: int = MAX_RETRIES,
    ) -> None:
        self.delay = delay
        self.jitter = jitter
        self.max_retries = max_retries
        self.request_count = 0
        self._session = requests.Session()
        # Warm the session (anonymous) so search cookies are set.
        self._session.get(SEARCH_URL, timeout=30, headers={"user-agent": USER_AGENT})

    def _pace(self) -> None:
        time.sleep(self.delay + random.uniform(0, self.jitter))

    def page(self, part: Partition, page: int, size: int = PAGE_SIZE) -> tuple[list[dict[str, Any]], int]:
        """POST one page; return (resultList, hitsTotal). Backs off on
        429/403/transient errors."""
        headers = {
            "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
            "origin": "https://sedo.com",
            "referer": SEARCH_URL,
            "x-requested-with": "XMLHttpRequest",
            "user-agent": USER_AGENT,
        }
        payload = _build_payload(part, page, size)
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            self._pace()
            self.request_count += 1
            try:
                resp = self._session.post(BASE_URL, data=payload, headers=headers, timeout=60)
                if resp.status_code in (429, 403):
                    raise requests.HTTPError(f"{resp.status_code} throttled")
                resp.raise_for_status()
                data = resp.json()
                sr = (
                    data.get("b", {}).get("general", {}).get("searchRequest", {})
                    or {}
                )
                rows = sr.get("resultList") or []
                hits = sr.get("hitsTotal")
                return list(rows), int(hits or 0)
            except Exception as e:  # noqa: BLE001 — retry any transient failure
                last_err = e
                backoff = BACKOFF_BASE * (2 ** attempt)
                print(f"      retry {attempt + 1}/{self.max_retries} after error: {e} "
                      f"(sleep {backoff:.0f}s)")
                time.sleep(backoff)
        raise RuntimeError(f"Sedo page fetch failed after {self.max_retries} retries: {last_err}")


# ---------- crawl engine ----------

def _record_domain(row: dict[str, Any]) -> str:
    return str(row.get("0") or "").strip().lower()


def _parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def crawl(
    fetcher: Any,
    root: Partition,
    *,
    max_requests: int = DEFAULT_MAX_REQUESTS,
    time_budget_sec: float = DEFAULT_TIME_BUDGET_SEC,
    on_records: Callable[[list[dict[str, Any]]], None] | None = None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Walk the partition tree, harvesting every leaf under the 10k cap.

    Resilient by design: a fetch failure on any single partition is
    recorded and skipped — it never aborts the whole crawl (critical for a
    multi-hour run where Sedo may throttle a runner IP partway through).
    Harvested rows stream to `on_records` as they arrive; `on_progress` is
    invoked after each partition with the live stats dict so the caller can
    checkpoint.
    """
    started = time.monotonic()
    stack: list[Partition] = [root]
    stats: dict[str, Any] = {
        "queries": 0,
        "request_count": 0,
        "leaves_harvested": 0,
        "leaves_truncated": 0,
        "rows_seen": 0,
        "max_hits_total": 0,
        "stopped_early": None,
        "truncated_partitions": [],
        "failed_partitions": [],
        "current_partition": None,
        "elapsed_sec": 0.0,
    }

    def budget_exhausted(reason_label: str) -> bool:
        if fetcher.request_count >= max_requests:
            stats["stopped_early"] = f"max_requests ({max_requests}) reached at {reason_label}"
            return True
        if time.monotonic() - started >= time_budget_sec:
            stats["stopped_early"] = f"time_budget ({time_budget_sec}s) reached at {reason_label}"
            return True
        return False

    def harvest_pages(part: Partition, first_rows: list[dict[str, Any]], max_page: int) -> list[dict[str, Any]]:
        """Page a leaf from 2..max_page, tolerating a mid-leaf fetch error
        (keep whatever we got)."""
        harvested = list(first_rows)
        for page in range(2, max_page + 1):
            if budget_exhausted(f"{part.label()} page {page}"):
                print(f"  STOP EARLY: {stats['stopped_early']}")
                stack.clear()
                break
            try:
                more, _ = fetcher.page(part, page=page)
            except Exception as e:  # noqa: BLE001
                print(f"  WARN fetch failed at {part.label()} page {page}: {e} — keeping partial leaf")
                stats["failed_partitions"].append(f"{part.label()} page {page}: {e}")
                break
            stats["queries"] += 1
            if not more:
                break
            harvested.extend(more)
        return harvested

    while stack:
        if budget_exhausted("partition pop"):
            print(f"  STOP EARLY: {stats['stopped_early']}")
            break
        part = stack.pop()
        stats["current_partition"] = part.label()
        stats["request_count"] = fetcher.request_count

        try:
            rows, hits = fetcher.page(part, page=1)
            stats["queries"] += 1
        except Exception as e:  # noqa: BLE001 — isolate, don't abort the crawl
            print(f"  WARN partition probe failed at {part.label()}: {e} — skipping")
            stats["failed_partitions"].append(f"{part.label()} probe: {e}")
            if on_progress:
                on_progress(stats)
            continue

        stats["max_hits_total"] = max(stats["max_hits_total"], hits)
        print(f"  [{part.label()}] hitsTotal={hits:,} rows={len(rows)}")

        if hits == 0:
            if on_progress:
                on_progress(stats)
            continue

        if hits <= REACHABLE_CAP:
            total_pages = min(MAX_PAGE, -(-min(hits, REACHABLE_CAP) // PAGE_SIZE))
            harvested = harvest_pages(part, rows, total_pages)
            stats["leaves_harvested"] += 1
            stats["rows_seen"] += len(harvested)
            if on_records:
                on_records(harvested)
        else:
            children = subdivide(part)
            if children:
                stack.extend(children)
            else:
                # Irreducible leaf still over 10k: harvest the reachable top
                # and flag it. (With the default dimensions this is rare.)
                print(f"  WARN irreducible leaf over cap ({hits:,}); harvesting top {REACHABLE_CAP:,}")
                harvested = harvest_pages(part, rows, MAX_PAGE)
                stats["leaves_truncated"] += 1
                stats["rows_seen"] += len(harvested)
                stats["truncated_partitions"].append(part.label())
                if on_records:
                    on_records(harvested)

        stats["request_count"] = fetcher.request_count
        stats["elapsed_sec"] = round(time.monotonic() - started, 1)
        if on_progress:
            on_progress(stats)

    stats["request_count"] = fetcher.request_count
    stats["elapsed_sec"] = round(time.monotonic() - started, 1)
    stats["current_partition"] = None
    return stats


# ---------- config helpers ----------

def _root_partition() -> Partition:
    tlds_env = os.environ.get("SEDO_DUMP_TLDS")
    tlds = (
        tuple(t.strip().lower() for t in tlds_env.split(",") if t.strip())
        if tlds_env else DEFAULT_TLDS
    )
    return Partition(tlds=tlds)


def _checkpoint_push(branch: str | None) -> None:
    """Commit + push progress.json mid-crawl so progress is observable via
    the contents API. Best-effort: any git failure is swallowed (the final
    commit-state step is the durable safety net)."""
    if not branch:
        return
    import subprocess
    try:
        subprocess.run(["git", "add", f"state/{SOURCE_ID}/{PROGRESS_FILE}"],
                       check=True, capture_output=True)
        committed = subprocess.run(
            ["git", "commit", "-m", "sedo_dump: progress checkpoint [skip ci]"],
            capture_output=True, text=True,
        )
        if committed.returncode != 0:
            return  # nothing new to commit
        push = subprocess.run(["git", "push", "origin", f"HEAD:{branch}"],
                              capture_output=True, text=True, timeout=90)
        if push.returncode != 0:
            # Remote advanced (e.g. concurrent push) — rebase once and retry.
            subprocess.run(["git", "pull", "--rebase", "origin", branch],
                           capture_output=True, text=True, timeout=90)
            subprocess.run(["git", "push", "origin", f"HEAD:{branch}"],
                           capture_output=True, text=True, timeout=90)
        print("      checkpoint pushed")
    except Exception as e:  # noqa: BLE001
        print(f"      checkpoint push failed (non-fatal): {e}")


# ---------- main entrypoint ----------

def run() -> int:
    config.load_registry()
    config.get_source(SOURCE_ID)  # validate registered
    today = datetime.now(timezone.utc).date().isoformat()
    branch = os.environ.get("GITHUB_REF_NAME")

    max_requests = int(os.environ.get("SEDO_DUMP_MAX_REQUESTS", DEFAULT_MAX_REQUESTS))
    time_budget = float(os.environ.get("SEDO_DUMP_TIME_BUDGET_SEC", DEFAULT_TIME_BUDGET_SEC))
    flush_every = int(os.environ.get("SEDO_DUMP_FLUSH_EVERY", FLUSH_EVERY))
    ckpt_every = int(os.environ.get("SEDO_DUMP_CHECKPOINT_PARTITIONS", CHECKPOINT_EVERY_PARTITIONS))
    root = _root_partition()

    print(f"[1/2] Crawling Sedo (partitioned, streaming) from root: {root.label()}")
    print(f"      caps: max_requests={max_requests} time_budget={time_budget:.0f}s "
          f"pacing≈{REQUEST_DELAY}-{REQUEST_DELAY + REQUEST_JITTER}s/req "
          f"flush_every={flush_every:,}")

    from ..universe import supabase_writer as _sw

    seen: set[str] = set()                  # all domains seen (dedupe + unique count)
    buffer: list[dict[str, Any]] = []       # universe entries pending upsert
    totals = {
        "universe_qualifying": 0, "rows_sent": 0, "batches": 0,
        "flushes": 0, "chunks_failed": 0, "rows_failed": 0,
        "upsert_status": "ok", "upsert_error": None,
    }

    def _upsert_chunk(chunk: list[dict[str, Any]]) -> bool:
        """Upsert one small chunk with retry on statement timeout. Returns
        True on success. Never raises — a persistently failing chunk is
        counted and skipped so the crawl keeps going."""
        for attempt in range(UPSERT_RETRIES):
            try:
                res = _sw.upsert_from_source(SOURCE_ID, chunk, today)
                if res.get("status") == "ok":
                    totals["rows_sent"] += res.get("rows_sent", 0)
                    totals["batches"] += res.get("batches", 0)
                    return True
                # creds missing / non-error skip — not retryable
                totals["upsert_status"] = res.get("status", "error")
                totals["upsert_error"] = res.get("reason")
                return False
            except Exception as e:  # noqa: BLE001 — Postgres timeout etc.
                msg = str(e)
                transient = ("57014" in msg or "timeout" in msg.lower()
                             or "statement" in msg.lower())
                if attempt < UPSERT_RETRIES - 1 and transient:
                    backoff = UPSERT_BACKOFF_BASE * (2 ** attempt)
                    print(f"      upsert chunk timeout (attempt {attempt + 1}); "
                          f"backing off {backoff:.0f}s")
                    time.sleep(backoff)
                    continue
                totals["upsert_status"] = "error"
                totals["upsert_error"] = msg[:300]
                return False
        return False

    def flush() -> None:
        if not buffer:
            return
        totals["flushes"] += 1
        pending = list(buffer)
        buffer.clear()
        ok_rows = 0
        for i in range(0, len(pending), UPSERT_CHUNK):
            chunk = pending[i : i + UPSERT_CHUNK]
            if _upsert_chunk(chunk):
                ok_rows += len(chunk)
            else:
                totals["chunks_failed"] += 1
                totals["rows_failed"] += len(chunk)
        print(f"      flush #{totals['flushes']}: +{ok_rows:,} ok "
              f"(cumulative {totals['rows_sent']:,}; failed {totals['rows_failed']:,})")

    def collect(rows: list[dict[str, Any]]) -> None:
        for row in rows:
            d = _record_domain(row)
            if not d or d in seen:
                continue
            seen.add(d)
            if univ.passes_universe_filter(d):
                buffer.append({"domain": d, "price": _parse_float(row.get("4000"))})
                totals["universe_qualifying"] += 1
                if len(buffer) >= flush_every:
                    flush()

    ckpt = {"n": 0, "t": time.monotonic()}

    def write_progress(stats: dict[str, Any], *, final: bool = False) -> None:
        state.write_json(SOURCE_ID, PROGRESS_FILE, {
            "report_date": today,
            "updated_at": datetime.now(timezone.utc).isoformat(),
            "final": final,
            "unique_domains": len(seen),
            "universe_qualifying": totals["universe_qualifying"],
            "rows_upserted": totals["rows_sent"],
            "rows_failed": totals["rows_failed"],
            "flushes": totals["flushes"],
            "queries": stats.get("queries"),
            "requests": stats.get("request_count"),
            "leaves_harvested": stats.get("leaves_harvested"),
            "failed_partitions": len(stats.get("failed_partitions", [])),
            "current_partition": stats.get("current_partition"),
            "elapsed_sec": stats.get("elapsed_sec"),
        })

    def on_progress(stats: dict[str, Any]) -> None:
        n = stats.get("queries", 0)
        if (n - ckpt["n"] >= ckpt_every
                or time.monotonic() - ckpt["t"] >= CHECKPOINT_EVERY_SEC):
            ckpt["n"], ckpt["t"] = n, time.monotonic()
            write_progress(stats)
            _checkpoint_push(branch)

    fetcher = SedoFetcher()
    status, error = "ok", None
    stats: dict[str, Any] = {"queries": 0, "request_count": 0, "leaves_harvested": 0,
                             "failed_partitions": [], "elapsed_sec": 0.0}
    try:
        stats = crawl(
            fetcher, root,
            max_requests=max_requests, time_budget_sec=time_budget,
            on_records=collect, on_progress=on_progress,
        )
        if stats.get("stopped_early") or stats.get("failed_partitions"):
            status = "partial"
    except Exception as e:  # noqa: BLE001 — preserve everything streamed so far
        status, error = "failed", f"{type(e).__name__}: {e}"
        print(f"  CRAWL ERROR (data gathered so far is preserved): {error}")
    finally:
        flush()  # land any buffered universe entries
    if status == "ok" and totals["rows_failed"]:
        status = "partial"  # crawl finished but some upserts couldn't land

    unique = len(seen)
    print(f"[2/2] Finalizing: status={status} unique={unique:,} "
          f"universe_qualifying={totals['universe_qualifying']:,} "
          f"upserted={totals['rows_sent']:,} elapsed={stats.get('elapsed_sec')}s")
    if stats.get("stopped_early"):
        print(f"      NOTE: {stats['stopped_early']}")
    if stats.get("failed_partitions"):
        print(f"      NOTE: {len(stats['failed_partitions'])} partition(s) failed and were skipped")

    write_progress(stats, final=True)
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, {
        "report_date": today,
        "status": status,
        "unique_domains": unique,
        "universe_qualifying": totals["universe_qualifying"],
        "crawl": stats,
    })
    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": status,
        "error": error,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "unique_domains": unique,
        "universe_qualifying": totals["universe_qualifying"],
        "universe_upsert": {
            "status": totals["upsert_status"],
            "rows_sent": totals["rows_sent"],
            "batches": totals["batches"],
            "flushes": totals["flushes"],
            "chunks_failed": totals["chunks_failed"],
            "rows_failed": totals["rows_failed"],
            "error": totals["upsert_error"],
        },
        "queries": stats.get("queries"),
        "requests": stats.get("request_count"),
        "rows_seen": stats.get("rows_seen"),
        "leaves_harvested": stats.get("leaves_harvested"),
        "leaves_truncated": stats.get("leaves_truncated"),
        "failed_partitions": stats.get("failed_partitions"),
        "stopped_early": stats.get("stopped_early"),
        "elapsed_sec": stats.get("elapsed_sec"),
    })

    if totals["rows_failed"]:
        print(f"      NOTE: {totals['rows_failed']:,} rows in {totals['chunks_failed']} "
              f"chunk(s) failed to upsert (idempotent re-run will catch them)")
    print("DONE")
    # Non-fatal: a partial run still committed its data; only a hard crawl
    # exception with zero progress is worth a non-zero exit.
    return 0 if status != "failed" or totals["rows_sent"] > 0 else 1
