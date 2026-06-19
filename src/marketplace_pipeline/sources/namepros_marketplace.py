"""NamePros marketplace — flag for-sale domains that meet our buy criteria.

NamePros' marketplace is Cloudflare-protected, so we fetch it through scrape.do
super-proxies (like Oxley / NameJet / MarkMonitor). This first version is a
PROBE: it fetches the buy-domains marketplace page (and the forum RSS), prints
the structure + sample listings + how many pass the shape filter, and does NOT
publish yet. Once the workflow log shows the real markup we finalize the parser
and turn on the review-sheet + Slack publish.

Buy criteria (inclusive net; value-vs-ask ranking + human review do the final cut):
  • popular / phrase TLDs (com net org io ai co app dev xyz tv me now …), one dot
  • no hyphens
  • SLD is a one/short word (<= ~6 alpha), a dictionary word, OR a short number (<= 5 digits)
  • price judged vs. value, not a flat cap (candy.com $100k good; backup.now $777; 1882.org $325)

Requires SCRAPE_DO_TOKEN.
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

SOURCE_ID = "namepros_marketplace"
SOURCE_LABEL = "NamePros Marketplace"
SOURCE_TIER = 2

# The marketplace section the user combs by hand today, plus the forum RSS (clean
# structured items when reachable). We dump both and keep whichever parses.
TARGET_URLS = [
    "https://www.namepros.com/marketplace/buy-domains/",
    "https://www.namepros.com/forums/buy-domains.49/index.rss",
]
SCRAPE_DO_BASE = "https://api.scrape.do/"

# Inclusive shape filter — popular + phrase/brandable TLDs.
POPULAR_TLDS = {
    "com", "net", "org", "io", "ai", "co", "app", "dev", "xyz", "tv", "me",
    "now", "gg", "sh", "vc", "to", "so", "fm", "cc", "ist",
}
SHORT_ALPHA_MAX = 6   # <= this many alpha chars = short/brandable, qualifies
SHORT_NUM_MAX = 5     # <= this many digits = short numeric, qualifies
DOMAIN_RE = re.compile(r"\b([a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,5})\b", re.IGNORECASE)
# A nearby asking/BIN price: "$777", "$12,500", "$1.2k", "USD 500".
PRICE_RE = re.compile(r"\$\s?([0-9][0-9,]*(?:\.\d+)?)\s?([km])?|([0-9][0-9,]{2,})\s?usd", re.IGNORECASE)
_STRIP_RE = re.compile(r"(?is)<(script|style|head|noscript)\b.*?</\1>")
CHALLENGE_RE = re.compile(r"just a moment|cf-browser-verification|attention required", re.I)


def shape_ok(domain: str) -> bool:
    """The inclusive buy-criteria shape gate (no dictionary check here — that's a
    later, DB-backed pass). Single dot, no hyphen, popular/phrase TLD, and the SLD
    is short alpha, OR a short number, OR a 7+ single word (dictionary-checked later)."""
    d = str(domain or "").strip().lower().lstrip(".")
    if d.count(".") != 1:
        return False
    sld, tld = d.split(".")
    if not sld or "-" in sld or tld not in POPULAR_TLDS:
        return False
    if sld.isdigit():
        return len(sld) <= SHORT_NUM_MAX
    if not re.fullmatch(r"[a-z]+", sld):  # pure alpha only (drop alnum mixes like a1b)
        return False
    return True  # short or long single-word alpha — length/dictionary refinement later


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


def _fetch(url: str) -> str:
    """Cloudflare-safe fetch: fast no-render first, then a rendered retry."""
    attempts = [("no-render", False, 90), ("render", True, 150)]
    last = None
    for label, render, timeout in attempts:
        try:
            html = _scrape_do_once(url, render=render, timeout=timeout)
            if html and not CHALLENGE_RE.search(html[:2000]):
                print(f"      scrape.do ok via {label} ({len(html):,} bytes)")
                return html
            last = f"{label}: challenge/empty"
            print(f"      scrape.do {label}: challenge/empty, trying next")
        except Exception as e:  # noqa: BLE001
            last = f"{label}: {e}"
            print(f"      scrape.do {label} failed: {e}")
        time.sleep(3)
    raise RuntimeError(f"scrape.do exhausted ({last})")


def extract_listings(html: str) -> list[dict[str, Any]]:
    """First-pass listing extraction: every domain-like token + the nearest price
    in its neighbourhood. Defensive — the real structure is confirmed from the
    probe log, then this is tightened."""
    body = _STRIP_RE.sub(" ", html or "")
    out: list[dict[str, Any]] = []
    matches = list(DOMAIN_RE.finditer(body))
    for i, m in enumerate(matches):
        host = m.group(1).lower()
        nxt = matches[i + 1].start() if i + 1 < len(matches) else len(body)
        window = body[m.end():min(nxt, m.end() + 200)]
        pm = PRICE_RE.search(window)
        price = None
        if pm:
            raw = (pm.group(1) or pm.group(3) or "").replace(",", "")
            try:
                price = float(raw)
                if (pm.group(2) or "").lower() == "k":
                    price *= 1000
                elif (pm.group(2) or "").lower() == "m":
                    price *= 1_000_000
                price = int(price)
            except ValueError:
                price = None
        out.append({"domain": host, "price": price})
    return out


def run() -> int:
    config.get_source(SOURCE_ID)
    print("[PROBE] NamePros marketplace — fetching via scrape.do (no publish yet)")
    for url in TARGET_URLS:
        print(f"\n=== {url} ===")
        try:
            html = _fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"      FETCH FAILED: {e}")
            continue
        listings = extract_listings(html)
        passing = [L for L in listings if shape_ok(L["domain"])]
        priced = [L for L in passing if L["price"]]
        print(f"      raw domain tokens: {len(listings):,} · pass shape filter: {len(passing):,} · with price: {len(priced):,}")
        if passing:
            print("      sample (shape-passing): " + ", ".join(
                f"{L['domain']}" + (f" ${L['price']:,}" if L["price"] else "") for L in passing[:40]
            ))
        else:
            snippet = _STRIP_RE.sub(" ", html)[:1500].replace("\n", " ")
            print("      no shape-passing domains — body snippet follows:")
            print("      " + snippet)

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID, "label": SOURCE_LABEL, "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(), "probe": True,
    })
    print("\nDONE (probe)")
    return 0
