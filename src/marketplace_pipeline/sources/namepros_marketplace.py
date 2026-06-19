"""NamePros marketplace — flag for-sale domains that meet our buy criteria.

NamePros' marketplace is Cloudflare-protected, so we fetch the buy-domains page
through scrape.do super-proxies (like Oxley / NameJet / MarkMonitor), extract the
listed domains + their asking price, keep the ones that fit our buy criteria, and
publish them as daily "good deals":
  • a Google Sheet (rebuilt each run) for review/export,
  • the per-source `new_today` feed → the SNAP Opportunities report,
  • a Slack post to the SNAP channel each run.

Buy criteria (inclusive net; value-vs-ask + human review do the final cut):
  • popular / phrase TLDs (com net org io ai co app dev xyz tv me now …), one dot
  • no hyphens
  • SLD is a short word (<= ~6 alpha), a single dictionary word, OR a short number (<= 5 digits)
  • price judged vs. value, not a flat cap (candy.com $100k good; backup.now $777; 1882.org $325)

Price pairing off the page is still being tightened (the run logs a sample of the
listing markup); a domain with no parsed price still flags, with a NamePros search
link so the price is one click away.

Requires SCRAPE_DO_TOKEN (+ SLACK_BOT_TOKEN for the Slack post).
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
from ..publishers import sheets as sheets_pub
from ..publishers import slack as slack_pub

SOURCE_ID = "namepros_marketplace"
SOURCE_LABEL = "NamePros Marketplace"
SOURCE_TIER = 2

LISTING_URL = "https://www.namepros.com/marketplace/buy-domains/"
SEARCH_URL = "https://www.namepros.com/search/?q={q}&o=date"  # per-domain jump to the listing
SCRAPE_DO_BASE = "https://api.scrape.do/"

# Inclusive shape filter — popular + phrase/brandable TLDs.
POPULAR_TLDS = {
    "com", "net", "org", "io", "ai", "co", "app", "dev", "xyz", "tv", "me",
    "now", "gg", "sh", "vc", "to", "so", "fm", "cc", "ist",
}
# NamePros' own + common infra/CDN/social hosts that pepper the page chrome.
DENY_HOSTS = {
    "namepros.com", "nameproscdn.com", "google.com", "googleapis.com", "gstatic.com",
    "schema.org", "purl.org", "w3.org", "jsdelivr.net", "cloudflare.com", "gravatar.com",
    "youtube.com", "facebook.com", "twitter.com", "x.com", "paypal.com", "googletagmanager.com",
    "doubleclick.net", "cloudflareinsights.com", "gtld-servers.net",
}
SHORT_NUM_MAX = 5     # <= this many digits = short numeric, qualifies
DOMAIN_RE = re.compile(r"\b([a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,5})\b", re.IGNORECASE)
# A nearby asking/BIN price: "$777", "$12,500", "$1.2k", "USD 500", "BIN $99".
PRICE_RE = re.compile(r"\$\s?([0-9][0-9,]*(?:\.\d+)?)\s?([km])?|\b([0-9][0-9,]{2,})\s?usd\b", re.IGNORECASE)
# NamePros renders each listing's price in a `<ul class="info"><li>Bid|BIN|Price|
# Buy Now|Make offer</li><li>$NNN</li>…<time data-expires…></time></ul>` block
# right after the domain title — pull the price straight out of that list.
INFO_RE = re.compile(r'class="info"(.*?)</ul>', re.IGNORECASE | re.DOTALL)
_STRIP_RE = re.compile(r"(?is)<(script|style|head|noscript)\b.*?</\1>")
CHALLENGE_RE = re.compile(r"just a moment|cf-browser-verification|attention required", re.I)


def shape_ok(domain: str) -> bool:
    """Inclusive buy-criteria shape gate (dictionary refinement is a later pass).
    Single dot, no hyphen, popular/phrase TLD, not a denylisted host, and the SLD
    is a short number, OR pure-alpha (short brandable / single word)."""
    d = str(domain or "").strip().lower().lstrip(".")
    if d.count(".") != 1 or d in DENY_HOSTS:
        return False
    sld, tld = d.split(".")
    if not sld or "-" in sld or tld not in POPULAR_TLDS:
        return False
    if sld.isdigit():
        return len(sld) <= SHORT_NUM_MAX
    return bool(re.fullmatch(r"[a-z]+", sld))  # pure alpha (length/dictionary refined later)


def _find_price(s: str) -> int | None:
    m = PRICE_RE.search(s or "")
    if not m:
        return None
    raw = (m.group(1) or m.group(3) or "").replace(",", "")
    try:
        v = float(raw)
    except ValueError:
        return None
    suf = (m.group(2) or "").lower()
    if suf == "k":
        v *= 1000
    elif suf == "m":
        v *= 1_000_000
    v = int(v)
    return v if 1 <= v <= 100_000_000 else None


def extract_listings(html: str) -> dict[str, int | None]:
    """Map each shape-passing listing domain → its asking price (or None).
    Body only (scripts/styles/head stripped), denylist removed, deduped (first
    non-null price wins). Each listing's price lives in the `<ul class="info">`
    block right after the domain title, so we take that first; the window is
    bounded by the NEXT shape-ok listing (not any href/profile domain in between,
    which used to truncate the window before the price) with a generic
    nearest-price fallback."""
    body = _STRIP_RE.sub(" ", html or "")
    # Only shape-ok domains anchor a listing — profile/CDN/href hosts in between
    # must NOT bound the window or they steal the price slot.
    spots = [(m.group(1).lower().lstrip("."), m.start(), m.end())
             for m in DOMAIN_RE.finditer(body)]
    spots = [(h, s, e) for (h, s, e) in spots if shape_ok(h)]
    out: dict[str, int | None] = {}
    for i, (host, _s, end) in enumerate(spots):
        nxt = spots[i + 1][1] if i + 1 < len(spots) else len(body)
        window = body[end:nxt]
        price = _price_from_info(window)
        if price is None:
            price = _find_price(window[:400])
        if host not in out or (out[host] is None and price is not None):
            out[host] = price
    return out


def _price_from_info(window: str) -> int | None:
    """Pull the price out of the listing's `<ul class="info"><li>Bid|BIN|Price…
    </li><li>$NNN</li>…</ul>` block (the `data-expires` time-left tag is ignored
    — it's a unix epoch, not a price, and lives in its own <li>)."""
    m = INFO_RE.search(window or "")
    if not m:
        return None
    return _find_price(m.group(1))


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
    for label, render, timeout in [("no-render", False, 90), ("render", True, 150)]:
        try:
            html = _scrape_do_once(url, render=render, timeout=timeout)
            if html and not CHALLENGE_RE.search(html[:2000]):
                print(f"      scrape.do ok via {label} ({len(html):,} bytes)")
                return html
            print(f"      scrape.do {label}: challenge/empty, trying next")
        except Exception as e:  # noqa: BLE001
            print(f"      scrape.do {label} failed: {e}")
        time.sleep(3)
    raise RuntimeError("scrape.do exhausted")


def _dump_price_markup(html: str, listings: dict[str, int | None]) -> None:
    """Log the raw markup around the first listing so price-pairing can be tightened
    from the workflow log without another blind round-trip."""
    body = _STRIP_RE.sub(" ", html or "")
    target = next(iter(listings), None)
    if not target:
        return
    idx = body.lower().find(target)
    if idx >= 0:
        print("      [markup sample] " + re.sub(r"\s+", " ", body[max(0, idx - 80):idx + 220]))


def _sheet_rows(listings: dict[str, int | None], today: str) -> list[dict[str, Any]]:
    return [
        {"domain": d, "price": (listings[d] if listings[d] is not None else ""),
         "source": SOURCE_ID, "date_added": today,
         "link": SEARCH_URL.format(q=d)}
        for d in sorted(listings, key=lambda d: (listings[d] is None, listings[d] or 0))
    ]


def run() -> int:
    src_cfg = config.get_source(SOURCE_ID)
    reg = config.load_registry()
    snap_cfg = reg["products"]["snap"]
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/4] Fetching NamePros buy-domains via scrape.do")
    html = _fetch(LISTING_URL)
    listings = extract_listings(html)
    priced = {d: p for d, p in listings.items() if p}
    domains = sorted(listings)
    print(f"      good-deal candidates: {len(domains):,} · with asking price: {len(priced):,}")
    if domains:
        print("      sample: " + ", ".join(
            f"{d}" + (f" ${listings[d]:,}" if listings[d] else "") for d in domains[:40]))
        _dump_price_markup(html, listings)

    # SNAP Opportunities report + admin drill-down read this.
    state.write_new_today(SOURCE_ID, domains)
    state.write_json(SOURCE_ID, "snapshot.json", listings)

    # Good-deals Google Sheet (rebuilt each run). Best-effort: only when an
    # output_sheet_id is configured + shared to the pipeline service account.
    sheet_id = src_cfg.get("output_sheet_id")
    sheet_url = ""
    if sheet_id and domains:
        try:
            sheets_pub.write_rows(
                spreadsheet_id=sheet_id, tab="NamePros",
                mode=sheets_pub.OwnershipMode.REBUILD_OWNED_SLICE, source=SOURCE_ID,
                rows=_sheet_rows(listings, today),
                default_header=["domain", "price", "link", "source", "date_added"],
            )
            sheet_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
            print(f"[2/4] Wrote {len(domains):,} rows to the good-deals sheet")
        except Exception as e:  # noqa: BLE001
            print(f"[2/4] Sheet write skipped: {e}")
    else:
        print("[2/4] No output_sheet_id set yet — skipping sheet (create one, share to the SA, add the id)")

    # Slack to the SNAP channel each run.
    posted = False
    if domains and os.environ.get("SLACK_BOT_TOKEN"):
        channel = os.environ.get(snap_cfg.get("slack_channel_env", ""), "") or os.environ.get("SLACK_CHANNEL_SNAP", "")
        if channel:
            top = sorted(priced.items(), key=lambda kv: kv[1])[:15] if priced else [(d, None) for d in domains[:15]]
            lines = [f"• {d}" + (f" — ${p:,}" if p else "") for d, p in top]
            text = (f":mag: *NamePros good deals* — {len(domains)} candidate(s) today "
                    f"({len(priced)} priced)\n" + "\n".join(lines))
            if sheet_url:
                text += f"\n<{sheet_url}|Full list →>"
            try:
                posted = slack_pub.post(channel=channel, source=SOURCE_ID, text=text,
                                        dedupe_key=slack_pub.make_fingerprint(text))
                print(f"[3/4] Slack posted to {channel}: {posted}")
            except Exception as e:  # noqa: BLE001
                print(f"[3/4] Slack post skipped: {e}")
        else:
            print("[3/4] No SNAP Slack channel configured — skipping Slack")
    else:
        print("[3/4] Slack skipped (no candidates or SLACK_BOT_TOKEN)")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID, "label": SOURCE_LABEL, "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(domains), "priced_count": len(priced),
        "slack_posted": posted,
    })
    print("[4/4] DONE")
    return 0
