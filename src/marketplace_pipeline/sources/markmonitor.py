"""MarkMonitor "Make an Offer" inventory.

MarkMonitor (Clarivate) brokers a curated list of premium domains on its
make-an-offer page. The page sits behind Cloudflare, so we fetch it through
scrape.do super-proxies (render=true — the listing grid may be JS-hydrated),
exactly like the Oxley / NameJet sources.

Tier-2 source (brokered third-party inventory, not Snagged-owned). Asking prices
ARE captured when listed (many rows show a price; the rest are "make an offer").
Parsing is row-aware so a priced row never leaks its price onto a price-less
neighbour (see extract_listings).

Extraction is deliberately defensive: the page's exact markup hasn't been
inspected directly (Cloudflare blocks the sandbox), so we strip <head>/<script>/
<style>, then pull domain-like tokens from the remaining body and drop a denylist
of MarkMonitor's own + common infra/social hosts. The universe filter removes the
rest of the noise. The first run prints a sample + counts (and dumps a body
snippet when it finds nothing) so the parser can be confirmed/tuned from the
workflow log without another round-trip.

Requires SCRAPE_DO_TOKEN + SUPABASE_NAMING_* secrets.
"""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..usage_log import record_usage
from ..filters import universe as univ
from ..universe import supabase_writer
from ..publishers import sheets as sheets_pub

SOURCE_ID = "markmonitor"
SOURCE_LABEL = "MarkMonitor"
SOURCE_TIER = 2

LISTING_URL = "https://www.markmonitor.com/domains-for-sale/make-an-offer/"
SCRAPE_DO_BASE = "https://api.scrape.do/"
REQUEST_TIMEOUT = 180

# Listing-domain tokens. Two regexes on purpose:
#  • CORE_DOMAIN_RE — the TLDs the universe cares about (what we ingest to the DB).
#  • ANY_DOMAIN_RE  — ANY plausible TLD (.us, .tv, .info, …). Used to delimit rows
#    so a non-core domain (e.g. vvv.us) still acts as a boundary and its price
#    can't leak back onto the previous in-list domain. The grid lists names on
#    many TLDs; ignoring them broke price alignment (off-by-a-row).
CORE_TLDS = ("com", "net", "org", "io", "ai", "co", "xyz", "dev", "app", "tv")
CORE_DOMAIN_RE = re.compile(
    r"\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:" + "|".join(CORE_TLDS) + r"))\b",
    re.IGNORECASE,
)
ANY_DOMAIN_RE = re.compile(
    r"\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+)\b",
    re.IGNORECASE,
)
# The per-listing call-to-action button that terminates every row ("Make Offer" /
# "Make an Offer"). It sits AFTER the domain + price, so it bounds the price scan.
ROW_DELIM_RE = re.compile(r"make\s+(?:an\s+)?offer", re.IGNORECASE)

# MarkMonitor's own + common infra/social/CDN hosts that appear in chrome, not
# the for-sale grid. The universe filter catches most junk; this kills the
# plausible-looking false positives (single dictionary-ish infra words).
DENY_HOSTS = {
    "markmonitor.com", "clarivate.com", "example.com", "example.org",
    "google.com", "googleapis.com", "gstatic.com", "googletagmanager.com",
    "google-analytics.com", "doubleclick.net", "youtube.com", "facebook.com",
    "fbcdn.net", "twitter.com", "x.com", "linkedin.com", "instagram.com",
    "cloudflare.com", "cloudfront.net", "jsdelivr.net", "jquery.com",
    "bootstrapcdn.com", "w3.org", "schema.org", "wordpress.org", "wp.com",
    "cookiebot.com", "hubspot.com", "hsforms.com", "vimeo.com", "bing.com",
    "adobe.com", "typekit.net", "fonts.net", "addtoany.com", "sharethis.com",
}


CHALLENGE_RE = re.compile(
    r"just a moment|cf-browser-verification|challenge-platform|attention required", re.I
)


def _scrape_do_once(url: str, *, render: bool, timeout: int) -> str:
    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN must be set")
    params: dict[str, str] = {"token": token, "url": url, "super": "true", "geoCode": "us"}
    if render:
        params.update({"render": "true", "waitUntil": "domcontentloaded", "customWait": "6000"})
    resp = requests.get(SCRAPE_DO_BASE, params=params, timeout=timeout)
    resp.raise_for_status()
    record_usage("scrape_do.request", 1, "snap")
    return resp.text


def _fetch_via_scrape_do(url: str) -> str:
    """Fetch a Cloudflare-protected URL through scrape.do, robustly.

    The make-an-offer grid is most likely server-rendered HTML, so try the fast
    non-render path first — render=true 502'd (scrape.do JS-render timeout). Fall
    back to a rendered fetch, retry transient 5xx with backoff, and reject
    Cloudflare challenge shells."""
    if not os.environ.get("SCRAPE_DO_TOKEN"):
        raise RuntimeError("SCRAPE_DO_TOKEN must be set")
    attempts = [("no-render", False, 90), ("render", True, 150), ("render", True, 150)]
    last_err: Any = None
    for label, render, timeout in attempts:
        try:
            html = _scrape_do_once(url, render=render, timeout=timeout)
            if html and not CHALLENGE_RE.search(html[:2000]):
                print(f"      scrape.do ok via {label} ({len(html):,} bytes)")
                return html
            last_err = f"{label}: challenge/empty response"
            print(f"      scrape.do {label}: challenge/empty, trying next")
        except Exception as e:  # noqa: BLE001
            last_err = f"{label}: {e}"
            print(f"      scrape.do {label} failed: {e}")
        time.sleep(3)
    raise RuntimeError(f"scrape.do exhausted all attempts ({last_err})")


# Strip the parts of the document that carry infra domains (scripts/styles/head).
_STRIP_RE = re.compile(r"(?is)<(script|style|head|noscript)\b.*?</\1>")

# An asking / BIN price near a listing: "$12,500", "$995", "12500 USD". Requires
# a $ prefix or USD suffix + ≥3 digits so bare years/counts don't match.
PRICE_RE = re.compile(r"\$\s?([0-9][0-9,]{2,}(?:\.\d{2})?)|([0-9][0-9,]{2,})\s?USD", re.I)


def _find_price(s: str) -> int | None:
    pm = PRICE_RE.search(s)
    if not pm:
        return None
    raw = (pm.group(1) or pm.group(2)).replace(",", "")
    try:
        v = int(float(raw))
    except ValueError:
        return None
    return v if 100 <= v <= 100_000_000 else None


def _registrable(raw: str) -> str:
    """Collapse a matched host to its registrable form (last two labels), dropping
    a leading www. — e.g. shop.lumina.com → lumina.com, www.vvv.us → vvv.us."""
    host = raw.lower().lstrip(".")
    if host.startswith("www."):
        host = host[4:]
    return ".".join(host.split(".")[-2:])


def extract_listings(html: str) -> dict[str, int | None]:
    """Map each for-sale domain → asking price (or None for make-an-offer).

    Row-aware. The grid renders one listing per row as `domain · price · "Make
    Offer"`, so a domain's price is the currency amount in the segment AFTER the
    domain and BEFORE the next boundary — whichever comes first of (a) the next
    domain of ANY TLD or (b) the next "Make Offer" button. Using any-TLD domains
    AND the row button as boundaries stops a priced row (e.g. vvv.us $10,000)
    from leaking its price onto a price-less neighbour above it (voicemail.com –).
    Only the core-TLD names are *kept* (the universe set); non-core domains still
    participate as boundaries so alignment is correct. First non-null price wins."""
    body = _STRIP_RE.sub(" ", html or "")
    # Every plausible domain (any TLD) is a boundary; core-TLD ones are the rows
    # we actually emit.
    all_doms = list(ANY_DOMAIN_RE.finditer(body))
    starts = [m.start() for m in all_doms]
    delims = [m.start() for m in ROW_DELIM_RE.finditer(body)]
    di = 0  # walking pointer into delims (positions are ascending)
    out: dict[str, int | None] = {}
    for i, m in enumerate(all_doms):
        host = _registrable(m.group(1))
        # Keep only core-TLD listings; non-core still acted as a boundary above.
        # (Checked on the registrable host so subdomains like shop.lumina.com pass.)
        if host.rsplit(".", 1)[-1] not in CORE_TLDS or host in DENY_HOSTS:
            continue
        next_dom = starts[i + 1] if i + 1 < len(starts) else len(body)
        # nearest "Make Offer" at/after this domain's end
        while di < len(delims) and delims[di] < m.end():
            di += 1
        next_del = delims[di] if di < len(delims) else len(body)
        seg = body[m.end():min(next_dom, next_del)]
        price = _find_price(seg)
        if host not in out or (out[host] is None and price is not None):
            out[host] = price
    return out


def extract_domains(html: str) -> list[str]:
    """Sorted unique registrable hosts (convenience wrapper over extract_listings)."""
    return sorted(extract_listings(html).keys())


def publish_to_sheet(listings: dict[str, int | None], today: str) -> None:
    """Mirror the FULL extracted list (with asking price when present) to the
    source's review spreadsheet (rebuilt each run). Best-effort — never fails the
    universe ingest."""
    src_cfg = config.get_source(SOURCE_ID)
    sheet_id = src_cfg.get("output_sheet_id")
    if not sheet_id:
        return
    rows = [
        {"domain": d, "price": (listings[d] if listings[d] is not None else ""),
         "source": SOURCE_ID, "date_added": today}
        for d in sorted(listings)
    ]
    sheets_pub.write_rows(
        spreadsheet_id=sheet_id,
        tab="MarkMonitor",
        mode=sheets_pub.OwnershipMode.REBUILD_OWNED_SLICE,
        source=SOURCE_ID,
        rows=rows,
        default_header=["domain", "price", "source", "date_added"],
    )


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/3] Fetching MarkMonitor make-an-offer page via scrape.do")
    html = _fetch_via_scrape_do(LISTING_URL)
    listings = extract_listings(html)
    raw_domains = sorted(listings)
    priced = {d: p for d, p in listings.items() if p}
    print(f"      page bytes: {len(html):,} · domain candidates: {len(raw_domains):,} "
          f"· with asking price: {len(priced):,}")
    if raw_domains:
        print("      sample: " + ", ".join(raw_domains[:40]))
        if priced:
            print("      priced sample: " + ", ".join(f"{d} ${p:,}" for d, p in list(priced.items())[:10]))
    else:
        # Self-diagnose without another round-trip: show a body snippet so the
        # parser can be tuned from the workflow log.
        snippet = _STRIP_RE.sub(" ", html)[:2000].replace("\n", " ")
        print("      WARNING: no domains extracted — body snippet follows:")
        print("      " + snippet)

    print("[2/3] Applying universe filter")
    universe_entries: list[dict[str, Any]] = [
        {"domain": d, "price": listings.get(d)}
        for d in raw_domains
        if univ.passes_universe_filter(d)
    ]
    print(f"      universe entries: {len(universe_entries):,}")

    print(f"[3/3] Upserting to Supabase name_universe (tier={SOURCE_TIER})")
    stats = supabase_writer.upsert_from_source(
        SOURCE_ID, universe_entries, today, source_tier=SOURCE_TIER, count_new=True,
    )
    if stats["status"] == "ok":
        print(f"      upserted {stats['rows_sent']:,} rows in {stats['batches']} batch(es); "
              f"net-new {stats.get('rows_new', 0):,}")
    else:
        print(f"      skipped: {stats.get('reason')}")

    # Mirror the full extracted list to the review spreadsheet (best-effort).
    try:
        publish_to_sheet(listings, today)
        print(f"      mirrored {len(raw_domains):,} domains to review sheet")
    except Exception as e:  # noqa: BLE001
        print(f"      sheet mirror skipped: {e}")

    # Auto-enrich just the MarkMonitor net-new (best-effort, cost-guarded:
    # enrich-batch auto runs realtime when cheap, else submits a 50%-off async
    # batch — so a huge first run submits async and returns fast rather than
    # blowing the runner timeout). Skipped when nothing is new / no API key.
    new_count = stats.get("rows_new", 0) if stats.get("status") == "ok" else 0
    if new_count and os.environ.get("ANTHROPIC_API_KEY"):
        import subprocess
        print(f"[4/4] Auto-enriching {new_count:,} net-new rows (enrich-batch auto)")
        try:
            subprocess.run(
                ["pipeline", "enrich-batch", "auto", "--target", "universe",
                 "--source", SOURCE_ID, "--new-since", today,
                 "--min-batch-saving", "5", "--commit"],
                check=False, timeout=300,
            )
        except Exception as e:  # noqa: BLE001
            print(f"      auto-enrich skipped: {e}")
    elif new_count:
        print("[4/4] Auto-enrich skipped: ANTHROPIC_API_KEY not set")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(raw_domains),
        "universe_count": len(universe_entries),
        "new_count": stats.get("rows_new", stats.get("rows_sent", 0)),
        "supabase_status": stats.get("status"),
    })

    print("DONE")
    return 0
