"""MarkMonitor "Make an Offer" inventory.

MarkMonitor (Clarivate) brokers a curated list of premium domains on its
make-an-offer page. The page sits behind Cloudflare, so we fetch it through
scrape.do super-proxies (render=true — the listing grid may be JS-hydrated),
exactly like the Oxley / NameJet sources.

Tier-2 source (brokered third-party inventory, not Snagged-owned). Prices are
not captured (each domain is "make an offer" — no list price on the grid).

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
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..usage_log import record_usage
from ..filters import universe as univ
from ..universe import supabase_writer

SOURCE_ID = "markmonitor"
SOURCE_LABEL = "MarkMonitor"
SOURCE_TIER = 2

LISTING_URL = "https://www.markmonitor.com/domains-for-sale/make-an-offer/"
SCRAPE_DO_BASE = "https://api.scrape.do/"
REQUEST_TIMEOUT = 180

# Domain-like tokens in the page body. Restricted to the TLDs the universe cares
# about so asset hosts (.png/.svg/etc.) and exotic TLDs never match.
DOMAIN_RE = re.compile(
    r"\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|ai|co|xyz|dev|app|tv))\b",
    re.IGNORECASE,
)

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


def _fetch_via_scrape_do(url: str) -> str:
    """Fetch a Cloudflare-protected URL through scrape.do (rendered)."""
    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN must be set")
    params = {
        "token": token,
        "url": url,
        "render": "true",   # the grid may be JS-hydrated
        "super": "true",    # residential proxies for CF bypass
        "geoCode": "us",
    }
    resp = requests.get(SCRAPE_DO_BASE, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    record_usage("scrape_do.request", 1, "snap")
    return resp.text


# Strip the parts of the document that carry infra domains (scripts/styles/head).
_STRIP_RE = re.compile(r"(?is)<(script|style|head|noscript)\b.*?</\1>")


def extract_domains(html: str) -> list[str]:
    """Domain names from the page BODY (scripts/styles/head removed), minus the
    denylist. Lowercased, registrable host only, deduped, sorted."""
    body = _STRIP_RE.sub(" ", html or "")
    found: set[str] = set()
    for m in DOMAIN_RE.finditer(body):
        d = m.group(1).lower().lstrip(".")
        # registrable host = last two labels (drop any leading subdomain like www.)
        parts = d.split(".")
        host = ".".join(parts[-2:])
        if host in DENY_HOSTS:
            continue
        found.add(host)
    return sorted(found)


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/3] Fetching MarkMonitor make-an-offer page via scrape.do")
    html = _fetch_via_scrape_do(LISTING_URL)
    raw_domains = extract_domains(html)
    print(f"      page bytes: {len(html):,} · domain candidates: {len(raw_domains):,}")
    if raw_domains:
        print("      sample: " + ", ".join(raw_domains[:40]))
    else:
        # Self-diagnose without another round-trip: show a body snippet so the
        # parser can be tuned from the workflow log.
        snippet = _STRIP_RE.sub(" ", html)[:2000].replace("\n", " ")
        print("      WARNING: no domains extracted — body snippet follows:")
        print("      " + snippet)

    print("[2/3] Applying universe filter")
    universe_entries: list[dict[str, Any]] = [
        {"domain": d, "price": None}
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
