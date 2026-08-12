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
import json
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


def _fetch_via_playwright(url: str) -> bytes | None:
    """LAST-RESORT fallback: when curl_cffi/direct/scrape.do are all blocked by a
    Cloudflare JS challenge (a 403 challenge page that TLS impersonation can't
    solve), drive a REAL headless Chromium — which auto-clears the managed
    challenge — lift the `cf_clearance` cookie + the browser's User-Agent, then
    download the 127 MB CSV over plain HTTP with those. (A browser handles a
    127 MB download poorly; the cookie handoff is the reliable part.) cf_clearance
    is bound to IP+UA, so we reuse the browser's exact UA and the same runner
    egress IP. Returns the body, or None if Chromium isn't installed / the
    challenge doesn't clear / the download isn't a valid feed."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:  # noqa: BLE001 — optional in some envs
        print(f"      playwright unavailable ({e}); cannot use browser fallback")
        return None
    from urllib.parse import urlsplit
    target = url.replace("http://", "https://", 1) if url.startswith("http://") else url
    parts = urlsplit(target)
    origin = f"{parts.scheme}://{parts.netloc}/"
    for attempt in range(2):
        ua = None
        jar: dict[str, str] = {}
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                try:
                    page = browser.new_page()
                    page.set_default_timeout(60_000)
                    page.goto(origin, wait_until="domcontentloaded", timeout=60_000)
                    # Give Cloudflare's managed challenge time to auto-solve and
                    # set cf_clearance (a real browser clears it in a few seconds).
                    for _ in range(20):
                        if any(c.get("name") == "cf_clearance" for c in page.context.cookies()):
                            break
                        page.wait_for_timeout(1_000)
                    ua = page.evaluate("() => navigator.userAgent")
                    jar = {c["name"]: c["value"] for c in page.context.cookies()}
                finally:
                    browser.close()
        except Exception as e:  # noqa: BLE001 — nav/timeout; retry
            print(f"      playwright attempt {attempt + 1}/2 failed: {e}")
            continue
        if "cf_clearance" not in jar:
            print(f"      playwright attempt {attempt + 1}/2: challenge did not clear (no cf_clearance)")
            continue
        # Download the big file with the cleared cookie + the SAME UA the browser used.
        try:
            headers = dict(_BROWSER_HEADERS)
            if ua:
                headers["User-Agent"] = ua
            resp = requests.get(target, headers=headers, cookies=jar, timeout=180)
            body = resp.content
            if resp.status_code == 200 and _is_valid_feed(body):
                print(f"      playwright+cookie ok ({len(body):,} bytes)")
                return body
            print(f"      playwright download attempt {attempt + 1}/2: HTTP {resp.status_code} ({len(body):,} bytes)")
        except requests.RequestException as e:
            print(f"      playwright download attempt {attempt + 1}/2 failed: {e}")
    return None


def _fetch_feed(url: str) -> bytes:
    """Download the Atom partner feed, transparently routing around Cloudflare.

    Order of preference:
      1. curl_cffi with a real Chrome TLS fingerprint — passes Cloudflare Bot
         Management (which flags plain `requests`) and downloads the full 127 MB
         directly. Reliable primary path when Cloudflare isn't JS-challenging.
      2. Plain `requests` direct over a persistent session — Cloudflare only
         challenges the runner IP intermittently, so this often works too.
      3. scrape.do — 502s on this large a download, so it rarely helps here, but
         kept for completeness / smaller feeds.
      4. Headless Chromium (Playwright) — LAST-RESORT backup for when a hard
         Cloudflare JS challenge blocks 1–3: solve it in a real browser, then
         download with the cf_clearance cookie. Needs Chromium installed in the
         workflow (`playwright install chromium`)."""
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

    # scrape.do may raise when its 5 attempts 502 out — catch it so the
    # headless-browser backup still gets a turn before we give up.
    try:
        return _fetch_via_scrape_do(url)
    except Exception as e:  # noqa: BLE001
        print(f"      scrape.do failed ({e}); trying headless-browser backup")

    body = _fetch_via_playwright(url)
    if body is not None:
        return body
    raise RuntimeError(
        "atom feed fetch failed: curl_cffi, direct, scrape.do, and Playwright all blocked"
    )


# ---------- Partnership API (primary source; bypasses the Cloudflare-walled CSV) ----------

# GET /api/marketplace/partnership-search returns the FULL live marketplace as
# JSON. It's on the /api/ path, which is NOT behind the Cloudflare bot-challenge
# that blocks the 134 MB public CSV on CI-runner IPs — so it's the reliable
# primary source. Auth: api_token (partnership API key) + user_id (Atom account).
PARTNERSHIP_API_URL = "https://www.atom.com/api/marketplace/partnership-search"
# page_size ~600 is honored (verified live); the loop tolerates any actual page
# size, so a server cap just changes the request count.
PARTNERSHIP_PAGE_SIZE = int(os.environ.get("ATOM_API_PAGE_SIZE") or 600)
PARTNERSHIP_DELAY_S = float(os.environ.get("ATOM_API_DELAY_S") or 0.25)


def _partnership_api_key() -> str | None:
    return os.environ.get("ATOM_PARTNERSHIP_KEY") or os.environ.get("ATOM_API_KEY") or None


def _partnership_configured() -> bool:
    return bool(_partnership_api_key() and os.environ.get("ATOM_USER_ID"))


def _api_record_to_row(rec: dict[str, Any]) -> dict[str, str]:
    """Map a partnership-search JSON record onto the CSV row shape the rest of the
    pipeline expects (title / verified / price / link), so downstream parsing,
    filtering, scoring, and diffing are unchanged."""
    price = rec.get("selling_price") or rec.get("full_price") or ""
    # partnership-search returns live marketplace inventory; Atom marks these
    # "Approved" (== ownership-verified). Anything else -> treat as not verified.
    verified = "1" if str(rec.get("status") or "").strip().lower() == "approved" else "0"
    return {
        "title": str(rec.get("domain_name") or "").strip(),
        "verified": verified,
        "price": str(price),
        "link": str(rec.get("purchase_url") or "").strip(),
    }


def _fetch_via_partnership_api() -> list[dict[str, str]]:
    """Pull the FULL Atom marketplace inventory via the authenticated Partnership
    API, paging through every result and returning CSV-shaped rows.

    Fails LOUDLY on a truncated pull (e.g. a mid-crawl rate-limit) rather than
    returning a partial set, so the caller never overwrites the diff snapshot
    with incomplete inventory (which would flag thousands of names as dropped)."""
    key = _partnership_api_key()
    user_id = os.environ.get("ATOM_USER_ID", "")
    sess = requests.Session()
    sess.headers.update(
        {"User-Agent": _BROWSER_HEADERS["User-Agent"], "Accept": "application/json"}
    )

    rows: list[dict[str, str]] = []
    total_records: int | None = None
    page = 1
    while True:
        params = {
            "api_token": key,
            "user_id": user_id,
            "page": page,
            "page_size": PARTNERSHIP_PAGE_SIZE,
        }
        data: Any = None
        for attempt in range(3):
            try:
                resp = sess.get(PARTNERSHIP_API_URL, params=params, timeout=90)
                data = resp.json()
                break
            except (requests.RequestException, ValueError) as e:
                if attempt == 2:
                    raise RuntimeError(f"partnership API request failed on page {page}: {e}")
                time.sleep(2 * (2 ** attempt))  # 2s, 4s
        if not isinstance(data, dict) or not data.get("success"):
            msg = data.get("message") if isinstance(data, dict) else str(data)[:200]
            raise RuntimeError(f"partnership API error on page {page}: {msg}")
        if total_records is None:
            total_records = int(data.get("total_records") or 0)
            print(f"      partnership API: {total_records:,} total records reported")
        batch = data.get("data") or []
        if not batch:
            break
        rows.extend(_api_record_to_row(r) for r in batch)
        if page == 1 or page % 50 == 0:
            print(f"      page {page}: +{len(batch)} (running total {len(rows):,})")
        if total_records and len(rows) >= total_records:
            break
        page += 1
        time.sleep(PARTNERSHIP_DELAY_S)

    record_usage("atom.partnership_search", page, "snap")
    # Completeness guard: a truncated pull would silently shrink the inventory and
    # make the diff flag the missing names as "dropped". Require essentially the
    # full set (allow one short final page of slack).
    if total_records and len(rows) < total_records - PARTNERSHIP_PAGE_SIZE:
        raise RuntimeError(
            f"partnership API returned only {len(rows):,} of {total_records:,} records "
            f"(truncated pull — refusing to overwrite snapshot)"
        )
    print(f"      partnership API: fetched {len(rows):,} records across {page} page(s)")
    return rows


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

    print("[1/9] Loading Atom inventory")
    raw_filename = RAW_FILENAME
    if _partnership_configured():
        try:
            print("      primary: Partnership API (partnership-search)")
            rows = _fetch_via_partnership_api()
            raw = json.dumps(rows).encode("utf-8")
            raw_filename = "partner.json"
        except Exception as e:  # noqa: BLE001
            print(f"      partnership API failed ({e}); falling back to public CSV feed")
            raw = _fetch_feed(fetch_url)
            rows = parse_csv_rows(raw)
    else:
        print(f"      primary: public CSV feed {fetch_url}")
        raw = _fetch_feed(fetch_url)
        rows = parse_csv_rows(raw)
    print(f"      loaded {len(rows):,} rows ({len(raw):,} raw bytes)")

    print("[2/9] Caching raw to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=raw_filename, content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/9] Validating row count")
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
