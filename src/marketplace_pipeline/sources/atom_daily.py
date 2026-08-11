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
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, drive_cache, state
from ..filters import standard as flt
from ..filters import universe as univ
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode
from ..usage_log import record_usage

SOURCE_ID = "atom_daily"
SOURCE_LABEL = "Atom"

UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"

# Browser-ish headers so the direct fetch isn't trivially bot-blocked.
_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,text/plain,application/octet-stream,*/*",
}

SCRAPE_DO_BASE = "https://api.scrape.do/"
# Cloudflare challenge shell markers — if the direct fetch returns one of these
# (200 body OR 403 page), treat it as blocked and fall back to scrape.do.
_CF_CHALLENGE_MARKERS = (
    b"just a moment",
    b"cf-browser-verification",
    b"challenge-platform",
    b"cf-mitigated",
    b"attention required",
)

# The partner feed is ~127 MB / ~515K rows. A response materially smaller than
# this is NOT the real feed — a truncated download, a Cloudflare interstitial that
# happens not to match the markers above, or a proxy error body. Treating such a
# response as a valid (empty) feed once wiped the saved snapshot, so reject any
# body under this floor (retry / fall back / ultimately fail loudly, never
# overwrite good state with garbage). Env-overridable.
MIN_FEED_BYTES = int(os.environ.get("ATOM_MIN_FEED_BYTES") or 5_000_000)
# Belt-and-suspenders row floor applied AFTER parse, guarding every fetch path.
MIN_FEED_ROWS = int(os.environ.get("ATOM_MIN_FEED_ROWS") or 1_000)


def _looks_like_challenge(body: bytes) -> bool:
    head = body[:2000].lower()
    return any(m in head for m in _CF_CHALLENGE_MARKERS)


def _is_valid_feed(body: bytes) -> bool:
    """A plausibly-complete feed: non-empty, not a challenge shell, and at least
    MIN_FEED_BYTES (the real feed is ~127 MB, so this only rejects garbage)."""
    return bool(body) and len(body) >= MIN_FEED_BYTES and not _looks_like_challenge(body)


def _fetch_via_scrape_do(url: str) -> bytes:
    """Fetch a Cloudflare-protected URL through scrape.do, robust to the large file.

    Atom put the partner feed behind a Cloudflare challenge (cf-mitigated:
    challenge → 403 to a plain requests.get). scrape.do solves the challenge and
    returns the raw CSV — but the ~127 MB download **502s consistently through
    the residential `super` proxy** (it can't stream a file that large). The
    DATACENTER proxy (super off) handles the big download far better and scrape.do
    still bypasses Cloudflare on it, so try datacenter first, then super as a
    fallback for a tougher challenge. Retry transient failures with backoff, and
    hit the https URL directly to skip an http→https redirect hop."""
    token = os.environ.get("SCRAPE_DO_TOKEN") or os.environ.get("SCRAPE_DO_API_KEY")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN must be set to fetch the Cloudflare-protected Atom feed")
    target = url.replace("http://", "https://", 1) if url.startswith("http://") else url
    # (super?, label) per attempt — datacenter first (big-file friendly), then super.
    modes = [(False, "datacenter"), (False, "datacenter"), (True, "super"), (True, "super"), (True, "super")]
    last_err: Any = None
    for attempt, (use_super, label) in enumerate(modes):
        params = {"token": token, "url": target}
        if use_super:
            params.update({"super": "true", "geoCode": "us"})
        try:
            resp = requests.get(SCRAPE_DO_BASE, params=params, timeout=180)
            resp.raise_for_status()
            record_usage("scrape_do.request", 1, "snap")
            body = resp.content
            if _is_valid_feed(body):
                print(f"      scrape.do ok via {label} ({len(body):,} bytes)")
                return body
            last_err = f"{label}: challenge/undersized ({len(body):,} bytes)"
            print(f"      scrape.do attempt {attempt + 1}/{len(modes)} — {last_err}")
        except Exception as e:  # noqa: BLE001 — retry transient 5xx/timeouts
            last_err = f"{label}: {e}"
            print(f"      scrape.do attempt {attempt + 1}/{len(modes)} failed — {last_err}")
        if attempt < len(modes) - 1:
            time.sleep(2 * (2 ** min(attempt, 3)))  # 2s, 4s, 8s, 8s
    raise RuntimeError(f"scrape.do exhausted all attempts ({last_err})")


def _fetch_via_curl_cffi(url: str) -> bytes | None:
    """Fetch the feed with a real browser TLS/JA3 fingerprint (curl_cffi
    `impersonate`), which passes Cloudflare's Bot Management managed challenge
    that flags plain `requests`. This is the primary path: it gets past the 403
    challenge AND downloads the full ~127 MB directly (no proxy 502). Returns
    the body, or None if curl_cffi isn't installed / every attempt is blocked."""
    try:
        from curl_cffi import requests as creq  # lazy — optional dep
    except Exception as e:  # noqa: BLE001
        print(f"      curl_cffi unavailable ({e}); skipping to plain direct")
        return None
    attempts = 3
    last = ""
    for attempt in range(attempts):
        try:
            resp = creq.get(url, impersonate="chrome", timeout=180, allow_redirects=True)
            body = resp.content
            if resp.status_code == 200 and _is_valid_feed(body):
                print(f"      curl_cffi ok ({len(body):,} bytes)")
                return body
            last = (
                f"HTTP {resp.status_code}"
                f"{'/undersized-or-challenge' if resp.status_code == 200 else ''}"
                f" ({len(body):,} bytes)"
            )
        except Exception as e:  # noqa: BLE001
            last = str(e)
        print(f"      curl_cffi attempt {attempt + 1}/{attempts}: {last}")
        if attempt < attempts - 1:
            time.sleep(2 * (2 ** attempt))  # 2s, 4s
    print(f"      curl_cffi blocked ({last})")
    return None


def _fetch_feed(url: str) -> bytes:
    """Download the Atom partner feed, transparently routing around Cloudflare.

    Order of preference:
      1. curl_cffi with a real Chrome TLS fingerprint — passes Cloudflare Bot
         Management (which flags plain `requests`) and downloads the full 127 MB
         directly. This is the reliable primary path.
      2. Plain `requests` direct over a persistent session — Cloudflare only
         challenges the runner IP intermittently, so this often works too (and
         the `__cf_bm` cookie from a challenged response can let a retry through).
      3. scrape.do — last resort; note it 502s on this large a download, so it
         rarely helps here, but keep it for completeness / smaller feeds."""
    body = _fetch_via_curl_cffi(url)
    if body is not None:
        return body

    sess = requests.Session()
    sess.headers.update(_BROWSER_HEADERS)
    direct_attempts = 3
    last = ""
    for attempt in range(direct_attempts):
        try:
            resp = sess.get(url, timeout=180)
            if resp.status_code == 200 and _is_valid_feed(resp.content):
                if attempt:
                    print(f"      direct fetch ok on retry {attempt + 1}")
                return resp.content
            if resp.status_code == 200 and not _is_valid_feed(resp.content):
                last = f"HTTP 200 but undersized/challenge ({len(resp.content):,} bytes)"
            else:
                last = f"HTTP {resp.status_code}{'/challenge' if _looks_like_challenge(resp.content) else ''}"
        except requests.RequestException as e:
            last = str(e)
        if attempt < direct_attempts - 1:
            time.sleep(2 * (2 ** attempt))  # 2s, 4s
    print(f"      direct fetch blocked ({last}); falling back to scrape.do")
    return _fetch_via_scrape_do(url)


def _is_verified(row: dict[str, str]) -> bool:
    """Atom's partner feed marks ownership-verified listings with verified=1.
    A submitter can list a name that shows as "Pending Verification" (verified=0
    / blank) without actually owning it — those are effectively fake listings, so
    we ignore them everywhere (SNAP report + naming universe).

    Only filters when the feed actually carries a `verified` column; a feed/row
    without it (legacy `domain`-column feeds, tests) is treated as verified so we
    never drop everything if the column ever disappears."""
    if "verified" not in row:
        return True
    return str(row.get("verified") or "").strip() == "1"


def _universe_entries_from_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Apply ONLY the universe filter to Atom raw rows. Atom uses 'title' as
    the domain column (or 'domain' as fallback) and 'price' or
    'discount_price' for price — match both."""
    out: list[dict[str, Any]] = []
    for row in rows:
        if not _is_verified(row):  # skip pending-verification (unowned/fake) listings
            continue
        domain = (row.get("title") or row.get("domain") or "").strip().lower()
        if not domain or not univ.passes_universe_filter(domain):
            continue
        price_raw = row.get("price") or row.get("discount_price") or ""
        try:
            price = float(str(price_raw).replace(",", "")) if price_raw else None
        except ValueError:
            price = None
        out.append({"domain": domain, "price": price})
    return out

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
    # Skip pending-verification listings — the submitter may not actually own the
    # name (Atom shows "Pending Verification"), so it's a fake listing we ignore.
    if not _is_verified(row):
        return None
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
    raw = _fetch_feed(fetch_url)
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
    # Guard: a plausibly-complete feed has ~515K rows. If we somehow parsed far
    # fewer (a truncated/garbage body that slipped past the byte floor), ABORT
    # before overwriting the saved snapshot — an empty snapshot corrupts the diff
    # baseline and makes the next real run flag everything as new. Fail loudly.
    if len(rows) < MIN_FEED_ROWS:
        raise RuntimeError(
            f"Atom feed parsed only {len(rows):,} rows (< {MIN_FEED_ROWS:,}); "
            f"refusing to overwrite the snapshot with a partial/garbage feed "
            f"({len(raw):,} bytes fetched)."
        )

    print("[3b/9] Writing universe snapshot (broader filter for naming universe)")
    universe_entries = _universe_entries_from_rows(rows)
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)
    print(f"      universe entries: {len(universe_entries):,}")

    print("[3c/9] Upserting universe entries to Supabase name_universe")
    from ..universe import supabase_writer as _sw
    uni_stats = _sw.upsert_from_source(SOURCE_ID, universe_entries, today)
    if uni_stats["status"] == "ok":
        print(f"      upserted {uni_stats['rows_sent']:,} rows in {uni_stats['batches']} batch(es)")
    else:
        print(f"      skipped: {uni_stats.get('reason')}")

    print("[4/9] Filtering + scoring (strict SNAP filter for Slack/Sheets)")
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

    # Persist the feed-new names so the admin dashboard can show them
    # behind the "new today" count (mirrors the imports drill-down).
    state.write_new_today(SOURCE_ID, [e.domain for e in diff["new_entries"]])

    print("DONE")
    return 0
