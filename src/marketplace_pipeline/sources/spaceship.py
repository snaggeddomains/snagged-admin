"""Spaceship SellerHub aftermarket ingest.

Pulls the full Spaceship SellerHub marketplace inventory via the v1 REST
API, applies the universe filter, and upserts qualifying domains
directly into the Supabase name_universe table.

API contract (verified against bartwaardenburg/spaceship-mcp client):
  Base:        https://spaceship.dev/api
  Endpoint:    GET /v1/sellerhub/domains?take=<n>&skip=<offset>
  Auth:        X-API-Key + X-API-Secret headers (two-header pattern,
               NOT bearer)
  Pagination:  take + skip; response is {items: [...], total: int}.
               Keep paginating until skip >= total or items empty.

Env vars required:
  SPACESHIP_API_KEY      — generate in Spaceship API Manager
  SPACESHIP_API_SECRET   — corresponding secret for that key
  SUPABASE_NAMING_URL    — naming-universe project URL
  SUPABASE_NAMING_SERVICE_KEY — service role key for that project
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..filters import universe as univ
from ..universe import supabase_writer

SOURCE_ID = "spaceship"
SOURCE_LABEL = "Spaceship SellerHub"

BASE_URL = "https://spaceship.dev/api"
LISTINGS_PATH = "/v1/sellerhub/domains"
PAGE_SIZE = 100  # matches the upstream MCP client default
REQUEST_TIMEOUT = 60
MAX_RETRIES = 5
RETRY_BACKOFF_BASE = 2.0  # exponential: 2s, 4s, 8s, 16s, 32s

UNIVERSE_SNAPSHOT_FILE = "universe_snapshot.json"
SNAPSHOT_FILE = "snapshot.json"


def _headers() -> dict[str, str]:
    api_key = os.environ.get("SPACESHIP_API_KEY")
    api_secret = os.environ.get("SPACESHIP_API_SECRET")
    if not (api_key and api_secret):
        raise RuntimeError(
            "SPACESHIP_API_KEY and SPACESHIP_API_SECRET must both be set. "
            "Generate them together in the Spaceship API Manager."
        )
    return {
        "X-API-Key": api_key,
        "X-API-Secret": api_secret,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _fetch_page(skip: int, take: int = PAGE_SIZE) -> dict[str, Any]:
    """One paginated GET against /v1/sellerhub/domains with retry/backoff.

    On 4xx errors (auth, bad request, etc.) the response body is included
    in the raised error so workflow logs surface the actual problem instead
    of just an HTTP code.
    """
    url = f"{BASE_URL}{LISTINGS_PATH}"
    params = {"take": str(take), "skip": str(skip)}
    last_err: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.get(url, headers=_headers(), params=params, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            last_err = e
            print(f"        attempt {attempt} network error: {e}")
            time.sleep(RETRY_BACKOFF_BASE ** attempt)
            continue
        if resp.status_code == 429:
            wait = RETRY_BACKOFF_BASE ** attempt
            print(f"        attempt {attempt} hit 429; sleeping {wait:.0f}s")
            time.sleep(wait)
            continue
        if resp.status_code >= 500:
            wait = RETRY_BACKOFF_BASE ** attempt
            print(f"        attempt {attempt} got HTTP {resp.status_code}; sleeping {wait:.0f}s")
            print(f"        body: {resp.text[:400]}")
            time.sleep(wait)
            continue
        if 400 <= resp.status_code < 500:
            # Auth / bad request / scope error — body usually explains the
            # actual cause. Don't retry these (4xx == client error).
            body = resp.text.strip()[:600]
            raise requests.HTTPError(
                f"Spaceship API returned HTTP {resp.status_code} on "
                f"{LISTINGS_PATH}?take={take}&skip={skip}. Response body: {body}",
                response=resp,
            )
        resp.raise_for_status()
        return resp.json()
    raise RuntimeError(
        f"Spaceship API failed after {MAX_RETRIES} retries. Last error: {last_err}"
    )


def _extract_listing(item: dict[str, Any]) -> dict[str, Any] | None:
    """Pull domain + price out of a SellerHub listing item. The exact field
    shape from the API isn't fully documented publicly — extract defensively
    by checking common key variations and skipping malformed items."""
    domain = (
        item.get("domain")
        or item.get("domainName")
        or item.get("name")
        or ""
    )
    domain = str(domain).strip().lower()
    if not domain or "." not in domain:
        return None
    raw_price = (
        item.get("price")
        or item.get("askPrice")
        or item.get("listPrice")
        or item.get("buyNowPrice")
    )
    try:
        price = float(raw_price) if raw_price not in (None, "") else None
    except (TypeError, ValueError):
        price = None
    return {"domain": domain, "price": price}


def paginate_all() -> list[dict[str, Any]]:
    """Walk every page of /sellerhub/domains and return the flat list of
    {domain, price} dicts. Stops on empty page or when skip >= total."""
    all_listings: list[dict[str, Any]] = []
    skip = 0
    total: int | None = None
    page_num = 0
    while True:
        page_num += 1
        page = _fetch_page(skip=skip, take=PAGE_SIZE)
        items = page.get("items") or []
        if total is None:
            total = int(page.get("total") or 0)
            print(f"        total listings reported by API: {total:,}")
        for it in items:
            extracted = _extract_listing(it)
            if extracted:
                all_listings.append(extracted)
        if not items:
            print(f"        page {page_num}: empty — stopping")
            break
        skip += len(items)
        if page_num % 25 == 0:
            print(f"        page {page_num}: collected {len(all_listings):,} so far ({skip:,}/{total or '?'})")
        if total and skip >= total:
            break
    return all_listings


def _universe_entries_from_listings(listings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Apply the universe filter to raw API listings."""
    out: list[dict[str, Any]] = []
    for L in listings:
        domain = L["domain"]
        if univ.passes_universe_filter(domain):
            out.append(L)
    return out


def run() -> int:
    config.get_source(SOURCE_ID)
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/4] Paginating Spaceship SellerHub /v1/sellerhub/domains")
    all_listings = paginate_all()
    print(f"      collected {len(all_listings):,} raw listings")

    print("[2/4] Applying universe filter")
    universe_entries = _universe_entries_from_listings(all_listings)
    print(f"      universe entries: {len(universe_entries):,}")
    state.write_json(SOURCE_ID, UNIVERSE_SNAPSHOT_FILE, universe_entries)

    print("[3/4] Upserting universe entries to Supabase name_universe")
    uni_stats = supabase_writer.upsert_from_source(SOURCE_ID, universe_entries, today)
    if uni_stats["status"] == "ok":
        print(f"      upserted {uni_stats['rows_sent']:,} rows in {uni_stats['batches']} batch(es)")
    else:
        print(f"      skipped: {uni_stats.get('reason')}")

    print("[4/4] Saving raw snapshot for diff tracking")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, all_listings)

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "raw_count": len(all_listings),
        "universe_count": len(universe_entries),
        "new_count": uni_stats.get("rows_sent", 0),
        "supabase_status": uni_stats.get("status"),
    })

    print("DONE")
    return 0
