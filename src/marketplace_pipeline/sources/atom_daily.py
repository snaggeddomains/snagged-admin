"""Atom daily partner-feed diff.

Port of legacy/openclaw/scripts/atom_diff.py adapted to fetch directly
from the Atom partner feed URL (replacing the prior laptop-based dump-then-
upload-to-Drive workflow).

Pipeline:
  1. Download CSV from Atom partner feed
  2. Cache raw to Drive (Tier 2)
  3. Parse + filter (standard daily SNAP filter)
  4. Score (quality + deal; Atom uses a different deal scaling than other SNAP
     sources — see _atom_deal_score docstring)
  5. Diff vs previous snapshot
  6. Write to "Today's New Listings" (REPLACE_SOURCE_ROWS) — new entries only
  7. Write to "Running Good Deals" (APPEND_IF_MISSING) — only new domains
  8. Slack summary (only when there are new entries; matches legacy)
"""
from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, drive_cache, state
from ..filters import standard as flt
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode

SOURCE_ID = "atom_daily"
SOURCE_LABEL = "Atom"

MIN_LIST_PRICE = 99.0

# Atom-specific TLD weights — same set as Afternic (includes .computer)
TLD_WEIGHTS: dict[str, float] = {
    ".com": 1.0, ".ai": 0.9, ".io": 0.7, ".net": 0.7, ".co": 0.7,
    ".org": 0.6, ".computer": 0.3,
}

DIFF_HEADER = [
    "domain", "price", "tld", "source", "zipf_score", "quality_score",
    "deal_score", "link", "date_added", "prev_snapshot",
]
DIFF_TAB = "Today's New Listings"

RUNNING_HEADER = [
    "domain", "price", "tld", "zipf_score", "fast_transfer", "quality_score",
    "deal_score", "link", "date_added",
]
RUNNING_TAB = "Running Good Deals"

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "partner.csv"


def _tld_weight(tld: str) -> float:
    tld = (tld or "").strip().lower()
    if tld and not tld.startswith("."):
        tld = f".{tld}"
    return TLD_WEIGHTS.get(tld, 0.0)


def _atom_deal_score(zipf: float, price: float, weight: float) -> float:
    """Atom's deal score is intentionally unscaled vs Namecheap/Afternic.
    Legacy atom_diff.py uses (freq / max(price, MIN_PRICE)) * weight, no
    10000 multiplier. Preserving so sheet outputs match prior behavior.
    """
    if price <= 0:
        return 0.0
    return (zipf / max(price, 1.0)) * max(weight, 0.0)


def _atom_link(sld: str, given: str | None = None) -> str:
    given = (given or "").strip()
    if given:
        return given
    return f"https://www.atom.com/name/{sld}"


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
    link: str

    def to_diff_row(self, date_added: str, prev_snapshot: str) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": self.price,
            "tld": self.tld.lstrip("."),
            "source": SOURCE_LABEL,
            "zipf_score": round(self.zipf, 2),
            "quality_score": round(self.quality, 3),
            "deal_score": round(self.deal, 5),  # 5dp to preserve small values
            "link": self.link,
            "date_added": date_added,
            "prev_snapshot": prev_snapshot,
        }

    def to_running_row(self, date_added: str) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": round(self.price, 2),
            "tld": self.tld.lstrip("."),
            "zipf_score": round(self.zipf, 2),
            "fast_transfer": "NO",  # Atom does not surface fast-transfer
            "quality_score": round(self.quality, 3),
            "deal_score": round(self.deal, 5),
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
            "link": self.link,
            "date_added": date_added,
        }


# ---------- pure helpers ----------

def parse_csv_rows(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def entry_from_row(row: dict[str, str]) -> Entry | None:
    # Atom feed uses 'title' for the domain; some legacy feeds also use 'domain'
    domain = (row.get("title") or row.get("domain") or "").strip().lower()
    if not domain or not flt.allow_domain(domain):
        return None
    price_raw = row.get("price") or row.get("discount_price") or ""
    try:
        price = float(price_raw)
    except (TypeError, ValueError):
        return None
    if price < MIN_LIST_PRICE:
        return None
    sld, tld = flt.extract_sld_tld(domain)
    weight = _tld_weight(tld)
    if weight <= 0:
        return None
    zipf = flt.freq(sld)
    if zipf <= 0:
        return None
    quality = zipf * weight
    deal = _atom_deal_score(zipf, price, weight)
    return Entry(
        domain=domain, price=price, tld=tld, sld=sld,
        zipf=zipf, weight=weight, quality=quality, deal=deal,
        link=_atom_link(sld, row.get("link")),
    )


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
    # Sort new entries by (quality, deal) desc — legacy ordering
    new_entries = sorted(
        (curr_map[d] for d in new_domains),
        key=lambda e: (e.quality, e.deal),
        reverse=True,
    )
    return {
        "new_entries": new_entries,
        "dropped_domains": list(dropped_domains),
        "price_changes": price_changes,
    }


def build_slack_message(
    *,
    new_entries: list[Entry],
    report_date: str,
    sheet_url: str,
) -> str:
    lines = [f"Atom diff for {report_date} is live. Top new names:"]
    for e in new_entries[:10]:
        price = f"${e.price:,.0f}" if e.price >= 1000 else f"${e.price:.0f}"
        lines.append(f"• {e.domain} — {price} — quality {e.quality:.2f}")
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

    print(f"[1/9] Downloading {fetch_url}")
    resp = requests.get(fetch_url, timeout=180)
    resp.raise_for_status()
    raw = resp.content
    print(f"      fetched {len(raw):,} bytes")

    print("[2/9] Caching raw to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_FILENAME, content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/9] Parsing CSV")
    rows = parse_csv_rows(raw)
    print(f"      raw rows: {len(rows):,}")

    print("[4/9] Filtering + scoring")
    entries: list[Entry] = []
    for row in rows:
        e = entry_from_row(row)
        if e:
            entries.append(e)
    print(f"      qualifying entries: {len(entries):,}")

    print("[5/9] Diffing against previous snapshot")
    prev_snapshot = state.read_json(SOURCE_ID, SNAPSHOT_FILE, default=[])
    diff = diff_against_previous(entries, prev_snapshot)
    print(
        f"      new: {len(diff['new_entries'])}  "
        f"dropped: {len(diff['dropped_domains'])}  "
        f"price changes: {len(diff['price_changes'])}"
    )

    print(f"[6/9] Writing '{DIFF_TAB}' (new entries: {len(diff['new_entries'])})")
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
    print(f"      stats: {diff_stats}")

    print(f"[7/9] Appending to '{RUNNING_TAB}' (only domains not already present)")
    running_rows = [e.to_running_row(today) for e in diff["new_entries"]]
    running_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=RUNNING_TAB,
        mode=OwnershipMode.APPEND_IF_MISSING,
        source=SOURCE_LABEL,
        rows=running_rows,
        default_header=RUNNING_HEADER,
    )
    print(f"      stats: {running_stats}")

    print("[8/9] Saving snapshot")
    current_snapshot = [e.to_snapshot_dict(today) for e in entries]
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, current_snapshot)

    # Atom legacy posts to Slack only when there are new entries
    posted = False
    if diff["new_entries"]:
        print(f"[9/9] Posting to Slack channel {slack_channel}")
        message = build_slack_message(
            new_entries=diff["new_entries"],
            report_date=today,
            sheet_url=sheet_url,
        )
        posted = slack.post(
            channel=slack_channel,
            text=message,
            dedupe_key=slack.make_fingerprint(message),
            source=SOURCE_ID,
        )
        print(f"      slack posted: {posted}")
    else:
        print("[9/9] No new entries — skipping Slack")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(diff["new_entries"]),
        "dropped_count": len(diff["dropped_domains"]),
        "price_change_count": len(diff["price_changes"]),
        "fresh_added": diff_stats["added"],
        "running_appended": running_stats.get("added", 0),
        "slack_posted": posted,
    })

    print("DONE")
    return 0
