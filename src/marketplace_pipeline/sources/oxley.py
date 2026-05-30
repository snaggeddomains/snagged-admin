"""Oxley.com inventory (scraped homepage).

Oxley is an Efty-themed boutique marketplace (~100 curated single-word
.coms). Distinct from `efty_partner` which is a different Efty seller's
partner feed. We don't have Oxley's Efty token, so we scrape the public
homepage via scrape.do.

The homepage IS the catalog — there's no pagination and no separate
'browse all' page. Each listed domain renders as
`<a href="https://oxley.com/domain/<sld.tld>/">` per the Borgen Efty
theme, so the source ID is "domain hrefs on the homepage."

Per Rob's 2026-05-30 clarification, Oxley is TIER-2 (brokered third-party
inventory, not owned).

Prices are not captured in v1 — Oxley shows them on individual
/domain/<name>/ pages, which would require N+1 scrape.do calls per
run (~100 calls). Defer that to v2 once the basic ingestion is proven.
For now, every Oxley row lands with best_price = NULL.

Requires SCRAPE_DO_TOKEN + SUPABASE_NAMING_* secrets.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..filters import universe as univ
from ..universe import supabase_writer

SOURCE_ID = "oxley"
SOURCE_LABEL = "Oxley"
SOURCE_TIER = 2

HOMEPAGE_URL = "https://oxley.com/"
SCRAPE_DO_BASE = "https://api.scrape.do/"
REQUEST_TIMEOUT = 180

# Match the Borgen-theme link pattern:
#   <a href="https://oxley.com/domain/<sld>.<tld>/">
# Capture the bare domain (sld.tld) without the URL chrome.
DOMAIN_LINK_PATTERN = re.compile(
    r"https?://(?:www\.)?oxley\.com/domain/"
    r"([a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|io|ai|co|xyz|app|dev))/?",
    re.IGNORECASE,
)


def fetch_homepage_html() -> str:
    """Fetch oxley.com homepage via scrape.do (CF-protected; plain curl 403s)."""
    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN must be set")
    params = {
        "token": token,
        "url": HOMEPAGE_URL,
        "render": "true",
        "super": "true",
        "geoCode": "us",
    }
    resp = requests.get(SCRAPE_DO_BASE, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.text


def extract_domains(html: str) -> list[str]:
    """Extract unique lowercased domain names from /domain/<name>/ hrefs."""
    found: set[str] = set()
    for match in DOMAIN_LINK_PATTERN.finditer(html):
        found.add(match.group(1).lower())
    return sorted(found)


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/3] Fetching oxley.com homepage via scrape.do")
    html = fetch_homepage_html()
    print(f"      received {len(html):,} chars")

    print("[2/3] Extracting + filtering domains")
    raw_domains = extract_domains(html)
    print(f"      raw domains: {len(raw_domains):,}")
    universe_entries: list[dict[str, Any]] = [
        {"domain": d, "price": None}
        for d in raw_domains
        if univ.passes_universe_filter(d)
    ]
    print(f"      universe entries: {len(universe_entries):,}")

    print(f"[3/3] Upserting to Supabase name_universe (tier={SOURCE_TIER})")
    stats = supabase_writer.upsert_from_source(
        SOURCE_ID, universe_entries, today, source_tier=SOURCE_TIER,
    )
    if stats["status"] == "ok":
        print(f"      upserted {stats['rows_sent']:,} rows in {stats['batches']} batch(es)")
    else:
        print(f"      skipped: {stats.get('reason')}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(raw_domains),
        "universe_count": len(universe_entries),
        "new_count": stats.get("rows_sent", 0),
        "supabase_status": stats.get("status"),
    })

    print("DONE")
    return 0
