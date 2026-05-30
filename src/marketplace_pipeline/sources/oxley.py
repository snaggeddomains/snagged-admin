"""Oxley.com inventory (paginated via Efty's AJAX endpoint).

Oxley is an Efty-themed boutique marketplace with ~1,400 curated
single-word .coms. The homepage renders only the first 20 listings;
the rest come from an AJAX endpoint that powers the "Show more"
button, identified via browser dev-tools (2026-05-30).

Endpoint pattern (Efty's domain_overview_table widget):
    https://oxley.com/ajax/market_themes/domain_overview_table
        /user_id/<oxley-efty-user-id>
        /offset/<N>
        /filters/<url-encoded-json>
        /keyword//

Returns an HTML fragment containing <a href="/domain/<name>/"> links.
We loop offset 0, 20, 40, ... until the response yields zero new domains.

Tier-2 source per the playbook (brokered third-party inventory, not
Snagged-owned). Prices NOT captured here — they live on individual
/domain/<name>/ pages and would require N+1 scrape.do calls. Defer
that to v2 if it ever matters.

Requires SCRAPE_DO_TOKEN + SUPABASE_NAMING_* secrets.
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..filters import universe as univ
from ..universe import supabase_writer

SOURCE_ID = "oxley"
SOURCE_LABEL = "Oxley"
SOURCE_TIER = 2

# Oxley's Efty seller account ID (from the dev-tools-observed XHR).
# If we wired another Efty-themed marketplace, this would be the only
# constant that changes.
OXLEY_EFTY_USER_ID = "7192"

# Efty's domain_overview_table widget endpoint.
BASE_URL = "https://oxley.com/ajax/market_themes/domain_overview_table"

# Filter object the live site uses — broad enough to return everything.
DEFAULT_FILTERS: dict[str, str] = {
    "portfolio_price_min": "",
    "portfolio_price_max": "",
    "form-extensions": "all",
    "form-categories": "all",
    "age_val_min": "2",
    "age_val_max": "36",
    "length_val_min": "2",
    "length_val_max": "16",
    "": "",  # trailing empty key — Efty includes this; preserve for fidelity
}

PAGE_SIZE = 10           # the AJAX endpoint returns 10 items per call,
                         # NOT 20 — verified empirically: stepping by 20
                         # silently skipped every other batch, capping us
                         # at ~half the catalog. Step matches the actual
                         # response size.
MAX_PAGES = 300          # safety cap — would cover 3,000 domains, way
                         # over Oxley's ~1,400
REQUEST_TIMEOUT = 120
SCRAPE_DO_BASE = "https://api.scrape.do/"

# Match the /domain/<sld.tld>/ hrefs in the fragment HTML.
DOMAIN_LINK_PATTERN = re.compile(
    r"/domain/([a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|io|ai|co|xyz|app|dev))/?",
    re.IGNORECASE,
)


def _build_oxley_url(offset: int) -> str:
    """Construct the Efty domain_overview_table URL for a given offset."""
    filters_json = json.dumps(DEFAULT_FILTERS, separators=(",", ":"))
    filters_encoded = urllib.parse.quote(filters_json, safe="")
    return (
        f"{BASE_URL}"
        f"/user_id/{OXLEY_EFTY_USER_ID}"
        f"/offset/{offset}"
        f"/filters/{filters_encoded}"
        f"/keyword//"
    )


def _fetch_via_scrape_do(url: str) -> str:
    """Fetch a URL through scrape.do super-proxies. No render needed —
    the AJAX endpoint returns a plain HTML fragment, not a JS-driven SPA."""
    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("SCRAPE_DO_TOKEN must be set")
    params = {
        "token": token,
        "url": url,
        "super": "true",
        "geoCode": "us",
    }
    resp = requests.get(SCRAPE_DO_BASE, params=params, timeout=REQUEST_TIMEOUT)
    resp.raise_for_status()
    return resp.text


def extract_domains(html: str) -> list[str]:
    """Extract unique lowercased domain names from /domain/<name>/ hrefs
    in the fragment HTML."""
    found: set[str] = set()
    for m in DOMAIN_LINK_PATTERN.finditer(html):
        found.add(m.group(1).lower())
    return sorted(found)


def fetch_all_domains() -> list[str]:
    """Paginate through the Efty AJAX endpoint until exhausted.

    Stops when (a) a response yields zero new domains, (b) MAX_PAGES is
    reached, or (c) the response is empty. Dedups across pages — if
    Efty's pagination ever returns overlap, we don't double-count.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    offset = 0
    pages_fetched = 0

    while pages_fetched < MAX_PAGES:
        url = _build_oxley_url(offset)
        html = _fetch_via_scrape_do(url)
        page_domains = extract_domains(html)
        pages_fetched += 1

        if not page_domains:
            print(f"      offset {offset}: empty response, stopping")
            break

        new_this_page = [d for d in page_domains if d not in seen]
        if not new_this_page:
            print(f"      offset {offset}: no new domains, stopping")
            break

        seen.update(new_this_page)
        ordered.extend(new_this_page)

        if pages_fetched % 10 == 0 or pages_fetched <= 3:
            print(
                f"      offset {offset}: +{len(new_this_page)} new "
                f"({len(page_domains)} on page), running total {len(ordered):,}"
            )

        offset += PAGE_SIZE
        time.sleep(0.3)  # be polite to scrape.do + oxley

    return ordered


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/3] Paginating Oxley Efty AJAX endpoint")
    raw_domains = fetch_all_domains()
    print(f"      collected {len(raw_domains):,} unique raw domains")

    print("[2/3] Applying universe filter")
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
