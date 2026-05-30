"""Sedo net-new fresh marketplace results.

Combined port of two legacy scripts:
  - sedo_expiring_export.py  (fetches Sedo search backend, emits CSV)
  - sedo_net_new_slack.py    (reads CSV, diffs vs previous, writes a
                              dedicated 'Sedo Net-New' tab on the SNAP
                              sheet, posts Slack on net-new entries)

This is an aux feed (posts to #snap, NOT #auctions) — distinct from
sedo_expired_auctions which feeds the auctions sheet.

The Sedo search backend POST is form-encoded with a long parameter list
including hidden listing_type/category filters; the payload matches
legacy verbatim so server-side filters behave identically.

No new credentials needed — the Sedo search endpoint accepts anonymous
requests with a normal browser User-Agent.
"""
from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

import requests

from .. import config, drive_cache, state
from ..filters import standard as flt
from ..filters import universe as univ
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode

SOURCE_ID = "sedo_net_new"
SOURCE_LABEL = "Sedo"

# Fetch
BASE_URL = "https://sedo.com/service/common.php"
SEARCH_URL = "https://sedo.com/search/"
DEFAULT_TLDS = ("com", "net", "ai", "co")
DEFAULT_MIN_LEN = 1
DEFAULT_MAX_LEN = 12
DEFAULT_MAX_WORDS = 1
DEFAULT_MAX_AGE = 12
DEFAULT_SIZE = 500

USER_AGENT = (
    "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36"
)

# Sedo JSON field IDs -> column names (mirrors legacy CSV header)
FIELD_MAP = {
    "Domain Ace": "0",
    "Domain Idn": "2",
    "Tld": "4002",
    "Bids Count": "6",
    "Current Bid": "4000",
    "Currency": "4001",
    "Auction End Date": "1400",
    "Domain Length": "4004",
}

# Sheet: dedicated 'Sedo Net-New' tab on the SNAP sheet
SHEET_TAB = "Sedo Net-New"
SHEET_HEADER = ["Domain", "Auction End (ET)", "Price", "Link"]

SNAPSHOT_FILE = "snapshot.json"
SLACK_STATE_FILE = "slack_state.json"
UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"


def _universe_entries_from_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply ONLY the universe filter to Sedo raw API records. Sedo uses
    field key '0' for domain and '4000' for price."""
    out: list[dict[str, Any]] = []
    for row in records:
        domain = str(row.get("0") or "").strip().lower()
        if not domain or not univ.passes_universe_filter(domain):
            continue
        price = _parse_float(row.get("4000"))
        out.append({"domain": domain, "price": price})
    return out

EASTERN = ZoneInfo("America/New_York")


# ---------- fetch ----------

def _build_payload(
    *,
    tlds: list[str],
    length_min: int,
    length_max: int,
    max_words: int,
    max_age: int,
    size: int,
    page: int,
) -> list[tuple[str, str | int]]:
    payload: list[tuple[str, str | int]] = [
        ("safe_search", 2),
        ("synonyms", "true"),
        ("listing_type[]", 1),
        ("listing_type[]", 2),
        ("listing_type[]", 3),
        ("listing_type[]", 5),
        ("auction_group[]", 62),
        ("auction_event", ""),
        ("price_start", 0),
        ("price_end", 0),
        ("price_currency", 3),
        ("traffic_start", 0),
        ("traffic_end", 0),
        ("number_of_words_min", 1),
        ("number_of_words_max", max_words),
        ("len_min", length_min),
        ("len_max", length_max if length_max > 0 else 0),
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
        ("age_max", max_age),
        ("keyword", ""),
        ("page", page),
        ("rel", 6),
        ("orderdirection", 2),
        ("domainIds", ""),
    ]
    for tld in tlds:
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


def fetch_page(session: requests.Session, **kwargs: Any) -> list[dict[str, Any]]:
    """Fetch one Sedo search page; returns the resultList from the response."""
    headers = {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "origin": "https://sedo.com",
        "referer": SEARCH_URL,
        "x-requested-with": "XMLHttpRequest",
        "user-agent": USER_AGENT,
    }
    payload = _build_payload(**kwargs)
    resp = session.post(BASE_URL, data=payload, headers=headers, timeout=60)
    resp.raise_for_status()
    data = resp.json()
    try:
        return data["b"]["general"]["searchRequest"]["resultList"]
    except (KeyError, TypeError) as e:
        raise RuntimeError(f"Unexpected Sedo response payload: {data}") from e


# ---------- parse / transform ----------

def _parse_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def _parse_end(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value)
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except (ValueError, TypeError):
        pass
    try:
        dt = datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        return dt
    except (ValueError, TypeError):
        return None


def _to_et_display(dt: datetime | None) -> str:
    if dt is None:
        return "—"
    return dt.astimezone(EASTERN).strftime("%-m/%-d %-I:%M %p ET")


def _format_price(price: float | None, currency: str) -> str:
    if price is None:
        return "—"
    if float(price).is_integer():
        return f"{currency} {int(price):,}"
    return f"{currency} {price:,.2f}".rstrip("0").rstrip(".")


def parse_results(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply standard SNAP filter + extract the fields we need."""
    out: list[dict[str, Any]] = []
    for row in records:
        domain = str(row.get("0") or "").strip().lower()
        if not domain or not flt.allow_domain(domain):
            continue
        tld = str(row.get("4002") or "").strip().lower().lstrip(".")
        price = _parse_float(row.get("4000"))
        currency = (str(row.get("4001") or "").strip()) or "USD"
        end_dt = _parse_end(row.get("1400"))
        out.append({
            "domain": domain,
            "tld": tld,
            "price": price,
            "currency": currency,
            "end_time_utc": end_dt.isoformat() if end_dt else None,
            "url": f"https://sedo.com/search/details/?domain={domain}",
        })
    return out


def fetched_csv_bytes(records: list[dict[str, Any]], allowed_tlds: set[str]) -> bytes:
    """Build a CSV blob suitable for caching to Drive (legacy parity)."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    cols = list(FIELD_MAP.keys())
    writer.writerow(cols)
    for row in records:
        tld = str(row.get("4002", "")).lower().lstrip(".")
        if allowed_tlds and tld not in allowed_tlds:
            continue
        writer.writerow([row.get(FIELD_MAP[c], "") for c in cols])
    return buf.getvalue().encode("utf-8")


# ---------- sheet + slack ----------

def build_sheet_rows(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sorted by price desc, then domain; formatted for the Sedo Net-New tab."""
    sorted_rows = sorted(
        listings,
        key=lambda r: ((r.get("price") or -1), r.get("domain") or ""),
        reverse=True,
    )
    out: list[dict[str, Any]] = []
    for r in sorted_rows:
        end_dt = (
            datetime.fromisoformat(r["end_time_utc"].replace("Z", "+00:00"))
            if r.get("end_time_utc") else None
        )
        out.append({
            "Domain": r["domain"],
            "Auction End (ET)": _to_et_display(end_dt),
            "Price": _format_price(r.get("price"), r.get("currency") or "USD"),
            "Link": r.get("url") or "",
        })
    return out


def build_slack_message(
    *,
    new_listings: list[dict[str, Any]],
    total_filtered: int,
    sheet_url: str,
) -> str:
    now_et = datetime.now(EASTERN).strftime("%-m/%-d %-I:%M %p ET")
    lines = [
        f"Sedo net-new check ({now_et}): {len(new_listings)} new names matched "
        f"our filters, {total_filtered} current filtered names total.",
    ]
    for r in new_listings:
        end_dt = (
            datetime.fromisoformat(r["end_time_utc"].replace("Z", "+00:00"))
            if r.get("end_time_utc") else None
        )
        lines.append(
            f"• {r['domain']} - {_to_et_display(end_dt)} - "
            f"{_format_price(r.get('price'), r.get('currency') or 'USD')} - "
            f"<{r.get('url')}|link>"
        )
    lines.append("")
    lines.append(f"Full sheet: <{sheet_url}|sheet>")
    return "\n".join(lines)


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    snap_cfg = reg["products"]["snap"]
    sheet_id = snap_cfg["sheet_id"]
    slack_channel = os.environ.get(snap_cfg["slack_channel_env"], "C09B1P21YQ0")
    sheet_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
    today = datetime.now(timezone.utc).date().isoformat()

    tlds = list(DEFAULT_TLDS)
    allowed_tlds = {t.lower().lstrip(".") for t in tlds}

    print(f"[1/6] Fetching from {BASE_URL}")
    session = requests.Session()
    session.get(SEARCH_URL, timeout=30, headers={"user-agent": USER_AGENT})
    records = fetch_page(
        session,
        tlds=tlds,
        length_min=DEFAULT_MIN_LEN,
        length_max=DEFAULT_MAX_LEN,
        max_words=DEFAULT_MAX_WORDS,
        max_age=DEFAULT_MAX_AGE,
        size=DEFAULT_SIZE,
        page=1,
    )
    print(f"      raw rows: {len(records)}")

    print("[2/6] Caching raw CSV to Drive (Tier 2)")
    try:
        csv_blob = fetched_csv_bytes(records, allowed_tlds)
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID,
            report_date=today,
            filename="sedo_net_new.csv",
            content=csv_blob,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[2b/6] Writing universe snapshot (broader filter for naming universe)")
    universe_entries = _universe_entries_from_records(records)
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)
    print(f"      universe entries: {len(universe_entries):,}")

    print("[2c/6] Upserting universe entries to Supabase name_universe")
    from ..universe import supabase_writer as _sw
    uni_stats = _sw.upsert_from_source(SOURCE_ID, universe_entries, today)
    if uni_stats["status"] == "ok":
        print(f"      upserted {uni_stats['rows_sent']:,} rows in {uni_stats['batches']} batch(es)")
    else:
        print(f"      skipped: {uni_stats.get('reason')}")

    print("[3/6] Filtering through standard SNAP filter")
    listings = parse_results(records)
    listings = [L for L in listings if L["tld"] in allowed_tlds]
    print(f"      qualifying: {len(listings)}")

    print(f"[4/6] Writing '{SHEET_TAB}' (full rebuild — single-source tab)")
    sheet_rows = build_sheet_rows(listings)
    # REBUILD_OWNED_SLICE with predicate=True replaces every row
    sheet_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=SHEET_TAB,
        mode=OwnershipMode.REBUILD_OWNED_SLICE,
        source=SOURCE_LABEL,
        rows=sheet_rows,
        default_header=SHEET_HEADER,
        owner_predicate=lambda r: True,  # every row is ours
    )
    print(f"      stats: {sheet_stats}")

    print("[5/6] Diffing vs previous net-new state")
    prev_state = state.read_json(SOURCE_ID, SLACK_STATE_FILE, default={})
    prev_domains: set[str] = set(prev_state.get("domains") or [])
    new_listings = [L for L in listings if L["domain"] not in prev_domains]
    new_listings.sort(
        key=lambda r: ((r.get("price") or -1), r.get("domain") or ""),
        reverse=True,
    )
    print(f"      new since last run: {len(new_listings)}")

    posted = False
    if new_listings:
        print(f"[6/6] Posting to Slack channel {slack_channel}")
        message = build_slack_message(
            new_listings=new_listings,
            total_filtered=len(listings),
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
        print(f"[6/6] No new names since last run — skipping Slack")

    # Save snapshot + slack state
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)
    state.write_json(SOURCE_ID, SLACK_STATE_FILE, {
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "domains": sorted({L["domain"] for L in listings}),
    })

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_filtered": len(listings),
        "new_count": len(new_listings),
        "slack_posted": posted,
    })

    print("DONE")
    return 0
