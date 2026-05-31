"""Unit tests for the sedo_dump partitioned crawler.

Sedo blocks this sandbox's IP, so the live HTTP path can't run here; these
tests exercise the partition engine against a FakeFetcher that returns
synthetic inventory shaped like Sedo's JSON.
"""
from __future__ import annotations

from typing import Any

from marketplace_pipeline.sources import sedo_dump as src


class FakeFetcher:
    """Returns (rows, hitsTotal) from a synthetic per-TLD inventory.

    `inventory` maps a single TLD -> total domain count for that TLD. A
    partition's hitsTotal is the count of its TLD(s); rows are generated
    deterministically and respect page/pagesize so pagination/cap logic is
    exercised. Inventory is partitioned down by price band into equal
    slices so subdivision actually reduces hitsTotal.
    """

    def __init__(self, inventory: dict[str, int]) -> None:
        self.inventory = inventory
        self.request_count = 0

    def _hits(self, part: src.Partition) -> int:
        total = sum(self.inventory.get(t, 0) for t in part.tlds)
        # Each applied dimension that has >1 bucket cuts the slice down.
        if "price" in part.applied:
            total = total // len(src.PRICE_BANDS)
        if "length" in part.applied:
            total = total // len(src.LEN_BUCKETS)
        if "words" in part.applied:
            total = total // len(src.WORD_BUCKETS)
        return total

    def page(self, part: src.Partition, page: int, size: int = src.PAGE_SIZE):
        self.request_count += 1
        hits = self._hits(part)
        reachable = min(hits, src.REACHABLE_CAP)
        start = (page - 1) * size
        if start >= reachable:
            return [], hits
        n = min(size, reachable - start)
        key = "_".join(part.tlds) + f"_p{part.price_start}-{part.price_end}"
        rows = [{"0": f"{key}-{start + i}.{part.tlds[0]}", "4000": "100"} for i in range(n)]
        return rows, hits


def _collect(store: dict[str, dict[str, Any]]):
    def _on(rows):
        for r in rows:
            store[r["0"]] = r
    return _on


def test_small_tld_harvested_without_subdivision():
    # 1,200 .com domains -> under the 10k cap -> harvested directly,
    # paginated at 500 -> pages 1,2,3.
    fetcher = FakeFetcher({"com": 1_200})
    store: dict[str, dict[str, Any]] = {}
    stats = src.crawl(fetcher, src.Partition(tlds=("com",)), on_records=_collect(store))
    assert stats["leaves_harvested"] == 1
    assert stats["leaves_truncated"] == 0
    assert len(store) == 1_200
    # page 1 (probe) + pages 2,3 = 3 requests
    assert fetcher.request_count == 3


def test_empty_partition_skipped():
    fetcher = FakeFetcher({"com": 0})
    stats = src.crawl(fetcher, src.Partition(tlds=("com",)))
    assert stats["leaves_harvested"] == 0
    assert stats["rows_seen"] == 0
    assert fetcher.request_count == 1  # single probe, then skip


def test_over_cap_tld_subdivides_by_price():
    # 30k in one TLD -> over cap -> split by price into 6 bands of 5k each,
    # each band under cap and harvested.
    fetcher = FakeFetcher({"com": 30_000})
    store: dict[str, dict[str, Any]] = {}
    stats = src.crawl(fetcher, src.Partition(tlds=("com",)), on_records=_collect(store))
    assert stats["leaves_harvested"] == len(src.PRICE_BANDS)
    # No domain double-counted across bands (keys are band-scoped here, but
    # the run-level dedupe in run() keys on domain; engine streams all rows).
    assert stats["rows_seen"] == len(store)
    assert stats["leaves_truncated"] == 0


def test_multi_tld_root_under_cap_harvested_as_one_leaf():
    fetcher = FakeFetcher({"com": 800, "net": 600})
    store: dict[str, dict[str, Any]] = {}
    stats = src.crawl(
        fetcher, src.Partition(tlds=("com", "net")), on_records=_collect(store)
    )
    # Combined 1,400 < 10k cap, so the multi-TLD root is harvested directly
    # without splitting (TLD-first split only kicks in when over cap).
    assert stats["leaves_harvested"] == 1
    assert len(store) == 1_400


def test_subdivide_order_is_tld_then_price_then_length_then_words():
    p = src.Partition(tlds=("com", "net"))
    kids = src.subdivide(p)
    assert kids is not None and all(len(k.tlds) == 1 for k in kids)  # TLD first

    p2 = src.Partition(tlds=("com",), applied=frozenset({"tld"}))
    kids2 = src.subdivide(p2)
    assert kids2 is not None and "price" in kids2[0].applied  # then price

    p3 = src.Partition(tlds=("com",), applied=frozenset({"tld", "price"}))
    kids3 = src.subdivide(p3)
    assert kids3 is not None and "length" in kids3[0].applied  # then length

    p4 = src.Partition(tlds=("com",), applied=frozenset({"tld", "price", "length"}))
    kids4 = src.subdivide(p4)
    assert kids4 is not None and "words" in kids4[0].applied  # then words

    p5 = src.Partition(tlds=("com",), applied=frozenset({"tld", "price", "length", "words"}))
    assert src.subdivide(p5) is None  # exhausted


def test_irreducible_leaf_over_cap_is_truncated_not_dropped():
    # A single TLD with absurd inventory that stays over cap even after all
    # dimensions are applied -> harvested up to the cap and flagged.
    huge = 10_000 * len(src.PRICE_BANDS) * len(src.LEN_BUCKETS) * len(src.WORD_BUCKETS) * 2
    fetcher = FakeFetcher({"com": huge})
    store: dict[str, dict[str, Any]] = {}
    stats = src.crawl(fetcher, src.Partition(tlds=("com",)), on_records=_collect(store))
    assert stats["leaves_truncated"] >= 1
    assert stats["truncated_partitions"]


def test_max_requests_budget_stops_crawl():
    fetcher = FakeFetcher({"com": 30_000})
    stats = src.crawl(
        fetcher, src.Partition(tlds=("com",)), max_requests=2
    )
    assert stats["stopped_early"] is not None
    assert "max_requests" in stats["stopped_early"]


def test_build_payload_reflects_partition_fields():
    p = src.Partition(
        tlds=("com", "ai"), len_min=4, len_max=6,
        words_min=2, words_max=2, price_start=100, price_end=500,
    )
    payload = src._build_payload(p, page=3, size=500)
    d = dict(payload)  # later keys win, fine for scalar fields we check
    assert d["len_min"] == 4 and d["len_max"] == 6
    assert d["number_of_words_min"] == 2 and d["number_of_words_max"] == 2
    assert d["price_start"] == 100 and d["price_end"] == 500
    assert d["page"] == 3 and d["pagesize"] == 500
    # both TLDs present as repeated cc[] keys
    cc = [v for (k, v) in payload if k == "cc[]"]
    assert cc == ["com", "ai"]
