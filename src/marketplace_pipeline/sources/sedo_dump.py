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

from .. import config, drive_cache, state
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

SNAPSHOT_FILE = "snapshot.json"  # compact summary only — never the full dump


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
) -> dict[str, Any]:
    """Walk the partition tree, harvesting every leaf under the 10k cap.

    Returns stats. Harvested raw rows are passed to `on_records` as they
    arrive (so the caller can dedupe/stream without holding everything).
    """
    started = time.monotonic()
    stack: list[Partition] = [root]
    stats = {
        "queries": 0,
        "leaves_harvested": 0,
        "leaves_truncated": 0,
        "rows_seen": 0,
        "max_hits_total": 0,
        "stopped_early": None,
        "truncated_partitions": [],
    }

    def budget_exhausted(reason_label: str) -> bool:
        if fetcher.request_count >= max_requests:
            stats["stopped_early"] = f"max_requests ({max_requests}) reached at {reason_label}"
            return True
        if time.monotonic() - started >= time_budget_sec:
            stats["stopped_early"] = f"time_budget ({time_budget_sec}s) reached at {reason_label}"
            return True
        return False

    while stack:
        if budget_exhausted("partition pop"):
            print(f"  STOP EARLY: {stats['stopped_early']}")
            break
        part = stack.pop()
        rows, hits = fetcher.page(part, page=1)
        stats["queries"] += 1
        stats["max_hits_total"] = max(stats["max_hits_total"], hits)
        print(f"  [{part.label()}] hitsTotal={hits:,} rows={len(rows)}")

        if hits == 0:
            continue

        if hits <= REACHABLE_CAP:
            harvested = list(rows)
            total_pages = min(MAX_PAGE, -(-min(hits, REACHABLE_CAP) // PAGE_SIZE))
            for page in range(2, total_pages + 1):
                if budget_exhausted(f"{part.label()} page {page}"):
                    print(f"  STOP EARLY: {stats['stopped_early']}")
                    stack.clear()
                    break
                more, _ = fetcher.page(part, page=page)
                stats["queries"] += 1
                if not more:
                    break
                harvested.extend(more)
            stats["leaves_harvested"] += 1
            stats["rows_seen"] += len(harvested)
            if on_records:
                on_records(harvested)
            continue

        # Over the cap — try to split further.
        children = subdivide(part)
        if children:
            stack.extend(children)
        else:
            # Irreducible leaf still over 10k: harvest the reachable top
            # and flag it. (With the default dimensions this is rare.)
            print(f"  WARN irreducible leaf over cap ({hits:,}); harvesting top {REACHABLE_CAP:,}")
            harvested = list(rows)
            for page in range(2, MAX_PAGE + 1):
                if budget_exhausted(f"{part.label()} trunc page {page}"):
                    break
                more, _ = fetcher.page(part, page=page)
                stats["queries"] += 1
                if not more:
                    break
                harvested.extend(more)
            stats["leaves_truncated"] += 1
            stats["rows_seen"] += len(harvested)
            stats["truncated_partitions"].append(part.label())
            if on_records:
                on_records(harvested)

    stats["request_count"] = fetcher.request_count
    stats["elapsed_sec"] = round(time.monotonic() - started, 1)
    return stats


# ---------- config helpers ----------

def _root_partition() -> Partition:
    tlds_env = os.environ.get("SEDO_DUMP_TLDS")
    tlds = (
        tuple(t.strip().lower() for t in tlds_env.split(",") if t.strip())
        if tlds_env else DEFAULT_TLDS
    )
    return Partition(tlds=tlds)


def _universe_entries(records_by_domain: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply the universe filter to the deduped raw rows."""
    out: list[dict[str, Any]] = []
    for domain, row in records_by_domain.items():
        if not domain or not univ.passes_universe_filter(domain):
            continue
        out.append({"domain": domain, "price": _parse_float(row.get("4000"))})
    return out


# ---------- main entrypoint ----------

def run() -> int:
    config.load_registry()
    config.get_source(SOURCE_ID)  # validate registered
    today = datetime.now(timezone.utc).date().isoformat()

    max_requests = int(os.environ.get("SEDO_DUMP_MAX_REQUESTS", DEFAULT_MAX_REQUESTS))
    time_budget = float(os.environ.get("SEDO_DUMP_TIME_BUDGET_SEC", DEFAULT_TIME_BUDGET_SEC))
    root = _root_partition()

    print(f"[1/4] Crawling Sedo (partitioned) from root: {root.label()}")
    print(f"      caps: max_requests={max_requests} time_budget={time_budget:.0f}s "
          f"pacing≈{REQUEST_DELAY}-{REQUEST_DELAY + REQUEST_JITTER}s/req")

    # Dedupe across partition boundaries by domain, keeping the first seen.
    records_by_domain: dict[str, dict[str, Any]] = {}

    def collect(rows: list[dict[str, Any]]) -> None:
        for row in rows:
            d = _record_domain(row)
            if d and d not in records_by_domain:
                records_by_domain[d] = row

    fetcher = SedoFetcher()
    stats = crawl(
        fetcher, root,
        max_requests=max_requests,
        time_budget_sec=time_budget,
        on_records=collect,
    )
    unique = len(records_by_domain)
    print(f"      done: {stats['queries']} queries, {stats['request_count']} requests, "
          f"{stats['rows_seen']:,} rows, {unique:,} unique domains, "
          f"elapsed {stats['elapsed_sec']}s")
    if stats["stopped_early"]:
        print(f"      NOTE: {stats['stopped_early']}")
    if stats["truncated_partitions"]:
        print(f"      NOTE: {len(stats['truncated_partitions'])} partition(s) truncated at cap")

    print("[2/4] Caching raw dump to Drive (Tier 2)")
    try:
        import json as _json
        raw = _json.dumps(list(records_by_domain.values()), default=str).encode("utf-8")
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename="sedo_dump.json", content=raw,
        )
        print(f"      drive file id: {file_id} ({len(raw):,} bytes)")
    except Exception as e:  # noqa: BLE001 — non-fatal
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/4] Filtering to universe + upserting to Supabase name_universe")
    universe_entries = _universe_entries(records_by_domain)
    print(f"      universe-qualifying: {len(universe_entries):,} of {unique:,}")
    from ..universe import supabase_writer as _sw
    uni_stats = _sw.upsert_from_source(SOURCE_ID, universe_entries, today)
    if uni_stats["status"] == "ok":
        print(f"      upserted {uni_stats['rows_sent']:,} rows in {uni_stats['batches']} batch(es)")
    else:
        print(f"      skipped: {uni_stats.get('reason')}")

    print("[4/4] Writing run status")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, {
        "report_date": today,
        "unique_domains": unique,
        "universe_qualifying": len(universe_entries),
        "crawl": stats,
    })
    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "unique_domains": unique,
        "universe_qualifying": len(universe_entries),
        "queries": stats["queries"],
        "requests": stats["request_count"],
        "rows_seen": stats["rows_seen"],
        "leaves_harvested": stats["leaves_harvested"],
        "leaves_truncated": stats["leaves_truncated"],
        "stopped_early": stats["stopped_early"],
        "elapsed_sec": stats["elapsed_sec"],
    })

    print("DONE")
    return 0
