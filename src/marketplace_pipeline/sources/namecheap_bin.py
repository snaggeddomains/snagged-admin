"""Namecheap exclusive BIN daily diff.

Port of legacy/openclaw/scripts/namecheap_daily_diff.py.

Pipeline:
  1. Download CSV from Namecheap CDN
  2. Cache raw bytes to Drive (Tier 2)
  3. Parse + filter (standard daily SNAP filter)
  4. Score (quality + deal)
  5. Combined top-N shortlist (union of top-by-quality + top-by-deal)
  6. Diff vs previous snapshot
  7. Write new rows to SNAP sheet "Today's New Listings" (REPLACE_SOURCE_ROWS)
  8. Post Slack summary to #snap (fingerprint-deduped)
  9. Save current snapshot for tomorrow's diff
"""
from __future__ import annotations

import csv
import io
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, drive_cache, scoring, state
from ..filters import standard as flt
from ..filters import universe as univ
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode

UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"


def _universe_entries_from_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Apply ONLY the universe filter (structural + 1-or-2 dict words) to
    the raw CSV rows. Used to populate state/<source>/universe_snapshot.json
    which is what universe_sync reads — much broader than the SNAP-filtered
    snapshot.json used for Slack/Sheets output."""
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

SOURCE_ID = "namecheap_bin"
SOURCE_LABEL = "Namecheap"

MIN_BIN_PRICE = 99.0
TOP_N = 250

SHEET_HEADER = [
    "domain", "price", "tld", "source", "zipf_score", "quality_score",
    "deal_score", "link", "date_added", "prev_snapshot",
]
SHEET_TAB = "Today's New Listings"
SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"

SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "Namecheap_Market_Sales_Buy_Now.csv"


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

    def to_sheet_row(self, date_added: str, prev_snapshot: str) -> dict[str, Any]:
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


# ---------- pure helpers (testable without IO) ----------

def parse_csv_rows(content: bytes) -> list[dict[str, str]]:
    text = content.decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text)))


def entry_from_row(row: dict[str, str]) -> Entry | None:
    domain = (row.get("domain") or "").strip().lower()
    price_raw = row.get("price") or ""
    if not domain or not price_raw:
        return None
    try:
        price = float(str(price_raw).replace(",", ""))
    except ValueError:
        return None
    if price < MIN_BIN_PRICE:
        return None
    if not flt.allow_domain(domain):
        return None
    sld, tld = flt.extract_sld_tld(domain)
    weight = scoring.tld_weight(tld)
    if weight <= 0:
        return None
    zipf = flt.freq(sld)
    if zipf <= 0:
        return None
    quality = scoring.quality_score(zipf, weight)
    deal = scoring.deal_score(zipf, price, weight)
    link = (
        row.get("permalink")
        or f"https://www.namecheap.com/market/buynow/{domain}/"
    ).strip()
    return Entry(
        domain=domain, price=price, tld=tld, sld=sld,
        zipf=zipf, weight=weight, quality=quality, deal=deal, link=link,
    )


def build_shortlist(entries: list[Entry], top_n: int = TOP_N) -> list[Entry]:
    """Union of top-N by quality and top-N by deal, deduped on domain,
    ordered by (quality desc, deal desc)."""
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
    """Compute new / dropped / price-changed sets."""
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


def build_slack_message(
    *,
    new_entries: list[Entry],
    raw_count: int,
    filtered_count: int,
    total_ranked: int,
    fresh_added: int,
    dropped_count: int,
    price_change_count: int,
    sheet_url: str,
) -> str:
    lines = [
        "Namecheap exclusive daily diff is live.",
        f"Raw rows in CSV: {raw_count:,}",
        f"Filtered names scanned into shortlist pool: {filtered_count:,}",
        f"Ranked shortlist size: {total_ranked:,}",
        f"New qualifying names: {len(new_entries):,}",
        f"Rows added to Today's New Listings: {fresh_added:,}",
        f"Removals found: {dropped_count:,}",
        f"Price changes: {price_change_count:,}",
    ]
    if new_entries:
        lines.append("")
        lines.append("Top new qualifying names:")
        for e in new_entries[:10]:
            price = f"${e.price:,.0f}" if e.price >= 1000 else f"${e.price:.0f}"
            lines.append(
                f"• {e.domain} — {price} — quality {e.quality:.2f} — <{e.link}|link>"
            )
    else:
        lines.append("")
        lines.append("0 met criteria today.")
    lines.append("")
    lines.append(f"Full sheet: <{sheet_url}|sheet>")
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
            source=SOURCE_ID,
            report_date=today,
            filename=RAW_FILENAME,
            content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/9] Parsing CSV")
    rows = parse_csv_rows(raw)
    print(f"      raw rows: {len(rows):,}")

    print("[3b/9] Writing universe snapshot (broader filter for naming universe)")
    universe_entries = _universe_entries_from_rows(rows)
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)
    print(f"      universe entries: {len(universe_entries):,}")

    print("[4/9] Filtering + scoring (strict SNAP filter for Slack/Sheets)")
    entries: list[Entry] = []
    for row in rows:
        e = entry_from_row(row)
        if e:
            entries.append(e)
    print(f"      qualifying entries: {len(entries):,}")

    print("[5/9] Building combined shortlist")
    ranked = build_shortlist(entries)
    print(f"      shortlist size: {len(ranked):,}")

    print("[6/9] Diffing against previous snapshot")
    prev_snapshot = state.read_json(SOURCE_ID, SNAPSHOT_FILE, default=[])
    diff = diff_against_previous(ranked, prev_snapshot)
    print(
        f"      new: {len(diff['new_entries'])}  "
        f"dropped: {len(diff['dropped_domains'])}  "
        f"price changes: {len(diff['price_changes'])}"
    )

    print(f"[7/9] Writing sheet '{SHEET_TAB}'")
    prev_date = prev_snapshot[0].get("date_added", "") if prev_snapshot else ""
    new_rows = [e.to_sheet_row(today, prev_date) for e in diff["new_entries"]]
    sheet_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=SHEET_TAB,
        mode=OwnershipMode.REPLACE_SOURCE_ROWS,
        source=SOURCE_LABEL,
        rows=new_rows,
        report_date=today,
        default_header=SHEET_HEADER,
    )
    print(f"      sheet stats: {sheet_stats}")

    print("[8/9] Saving snapshot")
    current_snapshot = [e.to_snapshot_dict(today) for e in ranked]
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, current_snapshot)

    print(f"[9/9] Posting to Slack channel {slack_channel}")
    message = build_slack_message(
        new_entries=diff["new_entries"],
        raw_count=len(rows),
        filtered_count=len(entries),
        total_ranked=len(ranked),
        fresh_added=sheet_stats["added"],
        dropped_count=len(diff["dropped_domains"]),
        price_change_count=len(diff["price_changes"]),
        sheet_url=sheet_url,
    )
    posted = slack.post(
        channel=slack_channel,
        text=message,
        dedupe_key=slack.make_fingerprint(message),
        source=SOURCE_ID,
    )
    print(f"      slack posted: {posted}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(diff["new_entries"]),
        "dropped_count": len(diff["dropped_domains"]),
        "price_change_count": len(diff["price_changes"]),
        "fresh_added": sheet_stats["added"],
        "sheet_total_after": sheet_stats["total_after"],
        "slack_posted": posted,
    })

    print("DONE")
    return 0
