"""Afternic daily inventory diff.

Port of legacy/openclaw/scripts/afternic_diff.py + refresh_sublist_sheet.py.

Pipeline:
  1. Download zip from Afternic feed URL
  2. Cache raw zip to Drive (Tier 2)
  3. Extract CSV from inside the zip
  4. Parse + filter (standard daily SNAP filter)
  5. Score (quality + deal; Afternic TLD weights include .computer)
  6. Combined shortlist (top 250 by quality ∪ top 250 by deal)
  7. Diff vs previous snapshot
  8. Write to "Today's New Listings" (REPLACE_SOURCE_ROWS) — new entries only
  9. Write to "Running Good Deals" (REBUILD_OWNED_SLICE) — full shortlist
 10. Slack summary + snapshot save
"""
from __future__ import annotations

import csv
import io
import os
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import requests

from .. import config, drive_cache, state
from ..filters import standard as flt
from ..filters import universe as univ
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode

SOURCE_ID = "afternic"
SOURCE_LABEL = "Afternic"

UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"


def _universe_entries_from_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Apply ONLY the universe filter (structural + 1-or-2 dict words) to
    raw CSV rows. Populates state/<source>/universe_snapshot.json — what
    universe_sync reads — independent of the strict SNAP-filtered output."""
    out: list[dict[str, Any]] = []
    for row in rows:
        domain = (row.get("domain") or "").strip().lower()
        if not domain or not univ.passes_universe_filter(domain):
            continue
        price_raw = row.get("price") or ""
        try:
            price = float(str(price_raw).replace(",", "")) if price_raw else None
        except ValueError:
            price = None
        out.append({"domain": domain, "price": price})
    return out

MIN_BIN_PRICE = 99.0
TOP_N = 250
MAX_RUNNING_ROWS = 600

# Afternic-specific TLD weights — includes .computer (legacy parity), no .me
TLD_WEIGHTS: dict[str, float] = {
    ".com": 1.0, ".ai": 0.9, ".io": 0.7, ".net": 0.7, ".co": 0.7,
    ".org": 0.6, ".computer": 0.3,
}

DIFF_HEADER = [
    "domain", "price", "tld", "source", "zipf_score", "quality_score",
    "deal_score", "link", "date_added", "prev_snapshot",
]
DIFF_TAB = "Today's New Listings"

# Running Good Deals — 9 cols, no 'source' column. Ownership identified by
# afternic.com/domain/ link prefix (legacy parity).
RUNNING_HEADER = [
    "domain", "price", "tld", "zipf_score", "fast_transfer", "quality_score",
    "deal_score", "link", "date_added",
]
RUNNING_TAB = "Running Good Deals"
AFTERNIC_LINK_PREFIX = "afternic.com/domain/"

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_ZIP_NAME = "inventory.zip"


def _tld_weight(tld: str) -> float:
    tld = (tld or "").strip().lower()
    if tld and not tld.startswith("."):
        tld = f".{tld}"
    return TLD_WEIGHTS.get(tld, 0.0)


def _afternic_link(domain: str) -> str:
    return f"https://www.afternic.com/domain/{quote(domain, safe='')}"


@dataclass
class Entry:
    domain: str
    price: float
    tld: str
    sld: str
    zipf: float
    weight: float
    quality: float
    deal: float
    fast_transfer: bool
    link: str

    def to_diff_row(self, date_added: str, prev_snapshot: str) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": self.price,
            "tld": self.tld.lstrip("."),
            "source": SOURCE_LABEL,
            "zipf_score": round(self.zipf, 2),
            "quality_score": round(self.quality, 3),
            "deal_score": round(self.deal, 1),
            "link": self.link,
            "date_added": date_added,
            "prev_snapshot": prev_snapshot,
        }

    def to_running_row(self, date_added: str) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": self.price,
            "tld": self.tld.lstrip("."),
            "zipf_score": round(self.zipf, 2),
            "fast_transfer": "YES" if self.fast_transfer else "NO",
            "quality_score": round(self.quality, 3),
            "deal_score": round(self.deal, 1),
            "link": self.link,
            "date_added": date_added,
        }

    def to_snapshot_dict(self, date_added: str) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": self.price,
            "tld": self.tld,
            "sld": self.sld,
            "zipf": self.zipf,
            "weight": self.weight,
            "quality": self.quality,
            "deal": self.deal,
            "fast_transfer": self.fast_transfer,
            "link": self.link,
            "date_added": date_added,
        }


# ---------- pure helpers (testable) ----------

ZIP_MAGIC = b"PK\x03\x04"
GZIP_MAGIC = b"\x1f\x8b"


def extract_csv_from_zip(zip_bytes: bytes) -> bytes:
    """Open the zip in memory and return the first .csv member's contents."""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        csv_names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
        if not csv_names:
            raise RuntimeError(f"No .csv inside zip; members: {zf.namelist()}")
        with zf.open(csv_names[0]) as fh:
            return fh.read()


def csv_bytes_from_response(content: bytes) -> bytes:
    """Return CSV bytes from whatever Afternic returned.

    The endpoint with compress=1 has been observed to return either:
      - a zip wrapper containing a single .csv (legacy behavior), or
      - gzip-encoded CSV that `requests` auto-decompresses to raw CSV bytes
        before we see it, or
      - raw CSV bytes directly.

    We probe the magic bytes and dispatch.
    """
    if content[:4] == ZIP_MAGIC:
        return extract_csv_from_zip(content)
    if content[:2] == GZIP_MAGIC:
        # Should be rare — requests usually auto-decompresses gzip — but
        # handle it just in case (e.g., if response asked for raw bytes).
        import gzip
        return gzip.decompress(content)
    # Plausibly raw CSV. Sanity check: first 200 bytes should look text-y and
    # plausibly contain "domain" as a column name.
    head = content[:2048].decode("utf-8", errors="replace").lower()
    if "domain" not in head:
        raise RuntimeError(
            f"Afternic response is neither zip nor gzip nor recognizable CSV. "
            f"First 100 bytes: {content[:100]!r}"
        )
    return content


def parse_csv_rows(csv_bytes: bytes) -> list[dict[str, str]]:
    text = csv_bytes.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def entry_from_row(row: dict[str, str]) -> Entry | None:
    domain = (row.get("domain") or "").strip().lower()
    price_raw = row.get("price") or ""
    if not domain or not price_raw:
        return None
    try:
        price = float(price_raw)
    except ValueError:
        return None
    if price < MIN_BIN_PRICE:
        return None
    if not flt.allow_domain(domain):
        return None
    sld, tld = flt.extract_sld_tld(domain)
    weight = _tld_weight(tld)
    if weight <= 0:
        return None
    zipf = flt.freq(sld)
    if zipf <= 0:
        return None
    quality = zipf * weight
    deal = (zipf * weight) / max(price, 1.0) * 10000.0
    fast_raw = str(row.get("is-fast-transfer") or "0").strip().lower()
    fast = fast_raw in {"1", "yes", "true"}
    return Entry(
        domain=domain, price=price, tld=tld, sld=sld,
        zipf=zipf, weight=weight, quality=quality, deal=deal,
        fast_transfer=fast, link=_afternic_link(domain),
    )


def build_shortlist(entries: list[Entry], top_n: int = TOP_N) -> list[Entry]:
    by_quality = sorted(entries, key=lambda e: e.quality, reverse=True)[:top_n]
    by_deal    = sorted(entries, key=lambda e: e.deal,    reverse=True)[:top_n]
    combined: dict[str, Entry] = {}
    for e in by_quality + by_deal:
        combined[e.domain] = e
    return sorted(combined.values(), key=lambda e: (e.quality, e.deal), reverse=True)


def diff_against_previous(
    current: list[Entry],
    previous_snapshot: list[dict[str, Any]],
) -> dict[str, Any]:
    prev_map = {x["domain"]: x for x in previous_snapshot}
    curr_map = {e.domain: e for e in current}
    new_domains = curr_map.keys() - prev_map.keys()
    dropped_domains = prev_map.keys() - curr_map.keys()
    price_changes: list[dict[str, Any]] = []
    for d in curr_map.keys() & prev_map.keys():
        if round(float(prev_map[d].get("price", 0)), 2) != round(curr_map[d].price, 2):
            price_changes.append({
                "domain": d,
                "old_price": prev_map[d].get("price"),
                "new_price": curr_map[d].price,
            })
    new_entries = sorted(
        (curr_map[d] for d in new_domains),
        key=lambda e: e.deal, reverse=True,
    )
    return {
        "new_entries": new_entries,
        "dropped_domains": list(dropped_domains),
        "price_changes": price_changes,
    }


def build_slack_message(*, new_entries: list[Entry], sheet_url: str) -> str:
    if not new_entries:
        return (
            "Afternic quality-first refresh is live. 0 new qualifying names.\n\n"
            f"Full sheet: {sheet_url}"
        )
    lines = ["Afternic quality-first refresh is live. Top movers:"]
    for e in new_entries[:10]:
        price = f"${e.price:,.0f}" if e.price >= 1000 else f"${e.price:.0f}"
        lines.append(f"• <{e.link}|{e.domain}> — {price} — quality {e.quality:.2f}")
    lines.append("")
    lines.append(f"Full sheet: {sheet_url}")
    return "\n".join(lines)


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    src_cfg = config.get_source(SOURCE_ID)
    snap_cfg = reg["products"]["snap"]
    sheet_id = snap_cfg["sheet_id"]
    slack_channel = os.environ.get(snap_cfg["slack_channel_env"], "C09B1P21YQ0")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    fetch_url = src_cfg["fetch"]["url"]
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/10] Downloading {fetch_url}")
    resp = requests.get(fetch_url, timeout=300)
    resp.raise_for_status()
    zip_bytes = resp.content
    print(f"       fetched {len(zip_bytes):,} bytes")

    print("[2/10] Caching raw zip to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_ZIP_NAME, content=zip_bytes,
        )
        print(f"       drive file id: {file_id}")
    except Exception as e:
        print(f"       WARN raw cache write failed (non-fatal): {e}")

    print("[3/10] Extracting CSV (zip / gzip / raw auto-detected)")
    csv_bytes = csv_bytes_from_response(zip_bytes)
    print(f"       got {len(csv_bytes):,} CSV bytes")

    print("[4/10] Parsing CSV")
    rows = parse_csv_rows(csv_bytes)
    print(f"       raw rows: {len(rows):,}")

    print("[4b/10] Writing universe snapshot (broader filter for naming universe)")
    universe_entries = _universe_entries_from_rows(rows)
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)
    print(f"       universe entries: {len(universe_entries):,}")

    print("[5/10] Filtering + scoring (strict SNAP filter for Slack/Sheets)")
    entries: list[Entry] = []
    for i, row in enumerate(rows, start=1):
        e = entry_from_row(row)
        if e:
            entries.append(e)
        if i % 50000 == 0:
            print(f"       processed {i:,} rows, kept {len(entries):,}...")
    print(f"       qualifying entries: {len(entries):,}")

    print("[6/10] Building combined shortlist")
    ranked = build_shortlist(entries)
    print(f"       shortlist size: {len(ranked):,}")

    print("[7/10] Diffing against previous snapshot")
    prev_snapshot = state.read_json(SOURCE_ID, SNAPSHOT_FILE, default=[])
    diff = diff_against_previous(ranked, prev_snapshot)
    print(
        f"       new: {len(diff['new_entries'])}  "
        f"dropped: {len(diff['dropped_domains'])}  "
        f"price changes: {len(diff['price_changes'])}"
    )

    print(f"[8/10] Writing '{DIFF_TAB}' (new entries only)")
    prev_date = prev_snapshot[0].get("date_added", "") if prev_snapshot else ""
    diff_rows = [e.to_diff_row(today, prev_date) for e in diff["new_entries"]]
    diff_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=DIFF_TAB,
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source=SOURCE_LABEL,
        rows=diff_rows,
        report_date=today,
        default_header=DIFF_HEADER,
    )
    print(f"       stats: {diff_stats}")

    print(f"[9/10] Writing '{RUNNING_TAB}' (full shortlist, max {MAX_RUNNING_ROWS})")
    capped = ranked[:MAX_RUNNING_ROWS]
    running_rows = [e.to_running_row(today) for e in capped]
    running_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=RUNNING_TAB,
        mode=OwnershipMode.REBUILD_OWNED_SLICE,
        source=SOURCE_LABEL,
        rows=running_rows,
        default_header=RUNNING_HEADER,
        owner_predicate=lambda r: AFTERNIC_LINK_PREFIX in str(r.get("link", "")).lower(),
    )
    print(f"       stats: {running_stats}")

    print("[10/10] Saving snapshot + Slack post")
    current_snapshot = [e.to_snapshot_dict(today) for e in ranked]
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, current_snapshot)

    message = build_slack_message(new_entries=diff["new_entries"], sheet_url=sheet_url)
    posted = slack.post(
        channel=slack_channel,
        text=message,
        dedupe_key=slack.make_fingerprint(message),
        source=SOURCE_ID,
    )
    print(f"       slack posted: {posted}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(diff["new_entries"]),
        "dropped_count": len(diff["dropped_domains"]),
        "price_change_count": len(diff["price_changes"]),
        "fresh_added": diff_stats["added"],
        "running_total_after": running_stats["total_after"],
        "slack_posted": posted,
    })

    print("DONE")
    return 0
