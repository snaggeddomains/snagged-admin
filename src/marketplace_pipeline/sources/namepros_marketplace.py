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
from ..filters.standard import is_clean_word
from ..publishers import sheets as sheets_pub
from ..publishers import slack as slack_pub

SOURCE_ID = "namepros_marketplace"
SOURCE_LABEL = "NamePros Marketplace"
SOURCE_TIER = 2

LISTING_URL = "https://www.namepros.com/marketplace/buy-domains/"
# Fallback ONLY when a domain has no captured thread URL. NamePros' own /search/?q=
# renders a login-walled search FORM (no results), so use a Google site-search that
# reliably lands on the actual thread instead.
SEARCH_URL = "https://www.google.com/search?q=%22{q}%22+site:namepros.com"
SCRAPE_DO_BASE = "https://api.scrape.do/"

# Inclusive shape filter — popular + phrase/brandable TLDs. (.cc excluded — too
# low-value and prone to one seller's bundle flooding the day.)
POPULAR_TLDS = {
    "com", "net", "org", "io", "ai", "co", "app", "dev", "xyz", "tv", "me",
    "now", "gg", "sh", "vc", "to", "so", "fm", "ist",
}
# NamePros' own + common infra/CDN/social hosts that pepper the page chrome, PLUS
# major platforms / registrars / marketplaces that show up inside thread posts as
# comps or references (e.g. "sold like ebay.com", "list on godaddy") — never the
# domain actually being sold, so they must not leak in via the post-body drill.
DENY_HOSTS = {
    "namepros.com", "nameproscdn.com", "google.com", "googleapis.com", "gstatic.com",
    "schema.org", "purl.org", "w3.org", "jsdelivr.net", "cloudflare.com", "gravatar.com",
    "youtube.com", "facebook.com", "twitter.com", "x.com", "paypal.com", "googletagmanager.com",
    "doubleclick.net", "cloudflareinsights.com", "gtld-servers.net",
    # Comp / reference / platform domains (not listings):
    "ebay.com", "amazon.com", "apple.com", "microsoft.com", "netflix.com", "google.org",
    "instagram.com", "linkedin.com", "tiktok.com", "reddit.com", "pinterest.com",
    "wikipedia.org", "medium.com", "github.com", "shopify.com", "stripe.com",
    # Registrars / marketplaces / domain-industry sites:
    "godaddy.com", "spaceship.com", "namecheap.com", "dynadot.com", "porkbun.com",
    "sedo.com", "afternic.com", "dan.com", "atom.com", "brandbucket.com", "squadhelp.com",
    "escrow.com", "namebio.com", "godaddy.net", "uniregistry.com", "epik.com",
    "park.io", "sav.com", "bodis.com", "parkingcrew.com",
    # Free email / contact providers (show up as a poster's contact, never a listing):
    "gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "aol.com",
    "proton.me", "protonmail.com", "gmx.com", "mail.com", "ymail.com",
}
# A thread-post drill must not borrow a price from a "comp" sentence
# ("sold for", "comparable", "similar to", "like ebay.com").
COMP_CONTEXT_RE = re.compile(r"\b(sold|comp|comparable|similar|example|apprais|reg(?:ister|istered)? at|as seen)\b", re.IGNORECASE)
SHORT_NUM_MAX = 5     # <= this many digits = short numeric, qualifies
SHORT_ALPHA_MAX = 3   # <= this many letters = short premium (LL/LLL), kept regardless of dictionary
# Word-quality gate: an alpha SLD must be a real dictionary word at this zipf or
# above. NamePros' default is intentionally LOWER than the SNAP filter's 2.8 — the
# owner's wanted names include legit-but-rarer words (alliteration 2.54,
# nondescript 2.64) — but still far above made-up brandables (jobonly/hokul/
# spectranex = 0.00). Tunable via NAMEPROS_MIN_ZIPF.
NAMEPROS_MIN_ZIPF = float(os.environ.get("NAMEPROS_MIN_ZIPF") or 2.3)
# The leading (?<![a-z0-9-]) stops a sub-span match inside a longer hyphenated
# host — e.g. it must NOT pull "spiritual.com" out of "anti-spiritual.com".
DOMAIN_RE = re.compile(r"(?<![a-z0-9-])([a-z0-9][a-z0-9-]{0,62}\.[a-z]{2,5})\b", re.IGNORECASE)
# A nearby asking/BIN price: "$777", "$12,500", "$1.2k", "USD 500", "BIN $99".
PRICE_RE = re.compile(r"\$\s?([0-9][0-9,]*(?:\.\d+)?)\s?([km])?|\b([0-9][0-9,]{2,})\s?usd\b", re.IGNORECASE)
# NamePros renders each listing's price in a `<ul class="info"><li>Bid|BIN|Price|
# Buy Now|Make offer</li><li>$NNN</li>…<time data-expires…></time></ul>` block
# right after the domain title — pull the price straight out of that list. The
# PRESENCE of this widget is also what distinguishes a real marketplace listing
# from a domain that's just a footer/article/nav link on the page (escrow.com,
# fontawesome.com, domaining.com, …), which we must NOT flag as a "good deal".
INFO_RE = re.compile(r'class="info"(.*?)</ul>', re.IGNORECASE | re.DOTALL)
LISTING_LABEL_RE = re.compile(r"\b(bid|bin|buy now|make offer|offer|price)\b", re.IGNORECASE)
# The PRIMARY listing format on the buy-domains forum: each thread row's title is
# `…data-preview-url="/threads/<slug>.<id>/preview">backup.now - $777 today only</a>`
# — the domain(s) + asking price live in the title text, and the thread path is the
# public listing URL. (The other format, the `<ul class="info">` auction widget, is
# a secondary pass; it's mostly low-quality churn the dictionary gate drops.)
THREAD_RE = re.compile(r'data-preview-url="(/threads/[^"#?]+)"[^>]*>([^<]+)</a>', re.IGNORECASE)
NAMEPROS_BASE = "https://www.namepros.com"
# A title that looks like a MULTI-domain bundle — its full inventory lives in the
# post body, not the title, so it's worth drilling into (e.g. the ".ai for $135 …"
# bundle that holds alliteration.ai). Single "domain - $price" titles are skipped.
BUNDLE_KW_RE = re.compile(
    r"\b(pick|lots?|bundle|packages?|portfolio|bulk|batch|combo|names?|each|multiple|several|list)\b",
    re.IGNORECASE)
TLD_FOR_RE = re.compile(r"\.[a-z]{2,5}\s+for\b", re.IGNORECASE)  # ".ai for $135"
_STRIP_RE = re.compile(r"(?is)<(script|style|head|noscript)\b.*?</\1>")
CHALLENGE_RE = re.compile(r"just a moment|cf-browser-verification|attention required", re.I)


def shape_ok(domain: str) -> bool:
    """Buy-criteria gate. Single dot, no hyphen, popular/phrase TLD, not a
    denylisted host, and the SLD is one of:
      • a short number (<= SHORT_NUM_MAX digits, e.g. 1882, 404),
      • a short premium string (<= SHORT_ALPHA_MAX letters — the LL/LLL market),
      • a REAL dictionary word (zipf >= NAMEPROS_MIN_ZIPF).
    The dictionary gate is the fix for made-up brandables (jobonly/preformer/
    spectranex/hokul) — they're not words, so they're dropped; candy/backup/
    lobster/alliteration/nondescript pass."""
    d = str(domain or "").strip().lower().lstrip(".")
    if d.count(".") != 1 or d in DENY_HOSTS:
        return False
    sld, tld = d.split(".")
    if not sld or "-" in sld or tld not in POPULAR_TLDS:
        return False
    if sld.isdigit():
        return len(sld) <= SHORT_NUM_MAX
    if not re.fullmatch(r"[a-z]+", sld):
        return False  # pure alpha only (no alnum mixes)
    if len(sld) <= SHORT_ALPHA_MAX and tld == "com":
        return True  # LL/LLL.com — the genuine short-.com premium market
    # Everything else (incl. short strings on non-.com) must be a real word, so
    # random 3-letter combos like oyf.ai / rzt.ai / phk.net are dropped.
    return is_clean_word(sld, NAMEPROS_MIN_ZIPF)


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


DOMAIN_LOOKBACK = 400  # chars before an info widget to find its listing's domain


def _thread_rows(html: str) -> list[tuple[str, str]]:
    """Each buy-domains forum thread row as (listing_url, title)."""
    rows: list[tuple[str, str]] = []
    for m in THREAD_RE.finditer(html or ""):
        path, title = m.group(1), m.group(2)
        rows.append((NAMEPROS_BASE + path.replace("/preview", ""), title))
    return rows


def _parse_threads(html: str) -> dict[str, tuple[int | None, str]]:
    """Parse the buy-domains forum thread rows → {domain: (price, listing_url)}.
    Each row's title (`backup.now - $777 today only`) carries the domain(s) and
    asking price; the `data-preview-url` path is the public listing URL. A title
    can name several domains — each shape-ok one gets the title's price + URL."""
    out: dict[str, tuple[int | None, str]] = {}
    for url, title in _thread_rows(html):
        price = _find_price(title)
        for dm in DOMAIN_RE.finditer(title):
            host = dm.group(1).lower().lstrip(".")
            if not shape_ok(host):
                continue
            if host not in out or (out[host][0] is None and price is not None):
                out[host] = (price, url)
    return out


def _looks_bundle(title: str) -> bool:
    """A title worth drilling into: it lists 2+ domains, uses bundle wording
    (pick/lot/bundle/names/…), has a `.tld for $X` pattern, or quotes 2+ prices —
    all signals the full domain list is in the post body, not the title."""
    t = title or ""
    dom_tokens = sum(1 for m in DOMAIN_RE.finditer(t) if shape_ok(m.group(1)))
    if dom_tokens >= 2:
        return True
    return bool(BUNDLE_KW_RE.search(t) or TLD_FOR_RE.search(t) or t.count("$") >= 2)


def _post_body(html: str) -> str:
    """The first post's region of a thread page (XenForo `bbWrapper`) — where a
    multi-domain seller lists every domain + price. Bounded tightly so thread
    REPLIES (other users' offers / mentions) don't pollute the parse."""
    body = _STRIP_RE.sub(" ", html or "")
    i = body.lower().find("bbwrapper")
    if i < 0:
        i = body.lower().find("message-body")
    return body[i:i + 6000] if i >= 0 else body[:6000]


def _parse_post_domains(text: str, url: str) -> dict[str, tuple[int | None, str]]:
    """Domains + nearest prices listed in a thread post → {domain: (price, url)}.
    A domain sitting in a 'comp' sentence (sold for / similar to / appraised) is
    skipped — it's a reference, not the inventory being sold."""
    spots = [(m.start(), m.end(), m.group(1).lower().lstrip("."))
             for m in DOMAIN_RE.finditer(text) if shape_ok(m.group(1))]
    out: dict[str, tuple[int | None, str]] = {}
    for i, (start, end, host) in enumerate(spots):
        if COMP_CONTEXT_RE.search(text[max(0, start - 40):start]):
            continue  # "sold like <host>" / "comparable to <host>" — a reference
        if _embedded_in_phrase(text, start):
            continue  # glued to a preceding word — a phrase / space-split domain
        nxt = spots[i + 1][0] if i + 1 < len(spots) else len(text)
        price = _find_price(text[end:min(nxt, end + 120)])
        if host not in out or (out[host][0] is None and price is not None):
            out[host] = (price, url)
    return out


def extract_links(html: str) -> dict[str, str]:
    """{domain: NamePros listing-thread URL} so the UI/sheet links to the actual
    NamePros page rather than the bare domain."""
    return {d: u for d, (_p, u) in _parse_threads(html).items()}


def backfill_links(html: str, domains, links: dict[str, str]) -> None:
    """Give a thread URL to listing domains that the TITLE parse missed — the ones
    captured via the info-widget / fallback scan in extract_listings (they'd otherwise
    fall back to a NamePros *search* URL, which just lands on a search page). Bind each
    to the NEAREST preceding thread row (`data-preview-url`) in the page, so its Slack /
    sheet link opens the actual listing thread. Best-effort + in-place: only fills gaps."""
    raw = html or ""
    thread_pos = [(m.start(), NAMEPROS_BASE + m.group(1).replace("/preview", ""))
                  for m in THREAD_RE.finditer(raw)]
    if not thread_pos:
        return
    low = raw.lower()
    for host in domains:
        if links.get(host):  # already has a (truthy) thread URL
            continue
        i = low.find(host.lower())
        if i < 0:
            continue
        url = None
        for pos, u in thread_pos:  # nearest thread row starting at/before the domain
            if pos <= i:
                url = u
            else:
                break
        if url:
            links[host] = url


def extract_listings(html: str) -> dict[str, int | None]:
    """Map each REAL marketplace listing domain → its asking price (or None).
    Deduped (first non-null price wins).

    PRIMARY: the buy-domains forum thread rows — the domain + price are in the
    thread title and the listing is seller-curated (real names). SECONDARY: the
    `<ul class="info">` auction-widget format (bound to the nearest shape-ok
    domain before it), for any domain not already seen via a thread. Both feed
    through the dictionary `shape_ok` gate, so made-up brandables are dropped.
    Falls back to a generic nearest-price scan only if the page has neither."""
    listings: dict[str, int | None] = {d: p for d, (p, _u) in _parse_threads(html).items()}

    body = _STRIP_RE.sub(" ", html or "")
    # Every shape-ok domain occurrence with its span (document order).
    spots = [(mm.start(), mm.end(), mm.group(1).lower().lstrip("."))
             for mm in DOMAIN_RE.finditer(body) if shape_ok(mm.group(1))]

    used: set[int] = set()
    for m in INFO_RE.finditer(body):
        block = m.group(1)
        if "$" not in block and not LISTING_LABEL_RE.search(block):
            continue  # an info list that isn't a marketplace price widget
        bound = _bind_domain(spots, m.start(), used)
        if not bound:
            continue
        start_pos, host = bound
        used.add(start_pos)
        price = _find_price(block)
        if host not in listings or (listings[host] is None and price is not None):
            listings[host] = price
    if listings:
        return listings

    # Fallback: a page with no price widgets (markup changed) — generic nearest
    # price after each shape-ok domain, bounded by the next one.
    out: dict[str, int | None] = {}
    for i, (_s, end, host) in enumerate(spots):
        nxt = spots[i + 1][0] if i + 1 < len(spots) else len(body)
        price = _find_price(body[end:min(nxt, end + 400)])
        if host not in out or (out[host] is None and price is not None):
            out[host] = price
    return out


def _bind_domain(spots, block_start: int, used: set[int]):
    """The nearest shape-ok domain occurrence ending before `block_start` (the
    listing's title, just before its price widget) within `DOMAIN_LOOKBACK`, not
    already claimed by an earlier widget. Returns (start_pos, host) or None."""
    floor = block_start - DOMAIN_LOOKBACK
    for start, end, host in reversed(spots):  # nearest first
        if end > block_start:
            continue
        if end < floor:
            break  # past the lookback window — none closer
        if start not in used:
            return (start, host)
    return None


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


def _page_url(n: int) -> str:
    """XenForo marketplace pagination: page 1 is the base URL, page N is /page-N."""
    return LISTING_URL if n <= 1 else f"{LISTING_URL}page-{n}"


def _listing_count(html: str) -> int:
    """How many listings a page holds — forum thread rows (primary) plus auction
    widgets (secondary). Used to detect the end of pagination."""
    threads = len(THREAD_RE.findall(html or ""))
    widgets = sum(1 for b in INFO_RE.findall(_STRIP_RE.sub(" ", html or ""))
                  if "$" in b or LISTING_LABEL_RE.search(b))
    return threads + widgets


def _fetch_pages(max_pages: int) -> str:
    """The buy-domains page shows only the newest ~30 listings, so qualifying names
    a few pages deep were never seen — paginate and combine. Stops early when a
    page returns no listings (past the end) or a fetch fails. The combined HTML
    feeds extract_listings (regex-based, so concatenation is safe; dedup by host
    keeps the first price)."""
    parts: list[str] = []
    for n in range(1, max(1, max_pages) + 1):
        try:
            html = _fetch(_page_url(n))
        except Exception as e:  # noqa: BLE001
            print(f"      page {n}: fetch failed ({e}) — stopping pagination")
            break
        count = _listing_count(html)
        print(f"      page {n}: {count} listing(s)")
        if n > 1 and count == 0:
            break  # past the last page of listings
        parts.append(html)
        if n < max_pages:
            time.sleep(1)
    return "\n".join(parts)


def _drill_bundles(html: str, cap: int) -> dict[str, tuple[int | None, str]]:
    """Fetch the bundle-looking threads (capped) and pull every domain + price
    from their post bodies — the inventory that the list-page title hides (e.g.
    alliteration.ai inside a multi-domain `.ai` thread). Each fetch is a scrape.do
    call, so this is capped and limited to titles `_looks_bundle` flags."""
    if cap <= 0:
        return {}
    seen: set[str] = set()
    cands: list[tuple[str, str]] = []
    for url, title in _thread_rows(html):
        if url in seen:
            continue
        seen.add(url)
        if _looks_bundle(title):
            cands.append((url, title))
    if not cands:
        return {}
    print(f"      drilling {min(len(cands), cap)} of {len(cands)} bundle thread(s)")
    out: dict[str, tuple[int | None, str]] = {}
    for url, _title in cands[:cap]:
        try:
            thtml = _fetch(url)
        except Exception as e:  # noqa: BLE001
            print(f"      drill failed {url}: {e}")
            continue
        found = _parse_post_domains(_post_body(thtml), url)
        for host, val in found.items():
            if host not in out or (out[host][0] is None and val[0] is not None):
                out[host] = val
        time.sleep(1)
    return out


def _probe(combined_html: str, listings: dict[str, int | None], probe_domains: list[str]) -> None:
    """Diagnostic: for each domain of interest, report whether it appears on the
    fetched pages at all, whether it passes the shape filter, and whether it was
    captured — so a 'why didn't X show up?' is answered from the log, not guessed."""
    body = _STRIP_RE.sub(" ", combined_html or "").lower()
    for raw in probe_domains:
        d = raw.strip().lower().lstrip(".")
        if not d:
            continue
        in_page = d in body
        print(f"      [probe] {d}: on_page={in_page} shape_ok={shape_ok(d)} captured={d in listings}")
        if in_page and d not in listings:
            idx = body.find(d)
            print("        ctx: " + re.sub(r"\s+", " ", body[max(0, idx - 70):idx + 170]))


def _dump_price_markup(html: str, listings: dict[str, int | None]) -> None:
    """Census the listing price blocks so the workflow log shows the true price
    ceiling (how many listings even carry a fixed price vs. Make-offer) and a
    real sample, without another blind round-trip. NamePros renders each price in
    a `<ul class="info">` block; a block with no `$` is a Make-offer listing."""
    body = _STRIP_RE.sub(" ", html or "")
    blocks = INFO_RE.findall(body)
    with_price = sum(1 for b in blocks if "$" in b)
    print(f"      [info census] {len(blocks)} class=info blocks · {with_price} carry a $price")
    sample = next((b for b in blocks if "$" in b), blocks[0] if blocks else "")
    if sample:
        print("      [info sample] " + re.sub(r"\s+", " ", sample)[:200])


# Words that legitimately precede a domain in a sale title ("Selling backup.now",
# "for sale candy.com"). A domain preceded by ANY OTHER standalone word is likely
# embedded in a phrase or a space-split domain ("Anti spiritual.com" = the seller's
# antispiritual.com), so we skip it rather than flag the wrong name.
SALE_STOPWORDS = {
    "selling", "sell", "sells", "sale", "sales", "buy", "buying", "bought", "get",
    "grab", "premium", "rare", "brandable", "brand", "name", "names", "domain",
    "domains", "listing", "list", "my", "the", "a", "an", "for", "offer", "offers",
    "offering", "price", "priced", "asking", "bin", "auction", "available", "avail",
    "snag", "new", "hot", "fresh", "cheap", "quick", "reduced", "firm", "lease",
    "want", "wts", "wtb", "is", "now", "today", "only", "and", "or", "with",
}
_PRIOR_WORD_RE = re.compile(r"(?:^|\s)([A-Za-z]{2,})\s$")


def _embedded_in_phrase(text: str, start: int) -> bool:
    """True if the domain at `start` is glued to a preceding standalone word that
    is NOT a sale word — i.e. it's part of a phrase / space-split domain and the
    bare host is probably the wrong name. (A preceding domain's TLD like '.com '
    is not a standalone word, so multi-domain lists still pass.)"""
    m = _PRIOR_WORD_RE.search(text[max(0, start - 40):start])
    return bool(m) and m.group(1).lower() not in SALE_STOPWORDS


def slack_line(domain: str, price: int | None, url: str | None,
               *, site: str = "NamePros", search_url: str | None = None) -> str:
    """A Slack mrkdwn bullet: the domain (Slack auto-links it to the live site) +
    a separate hyperlink to the actual listing. **Label honesty matters:** when we
    captured the exact thread/post URL the link deep-links to it and is labeled
    "<site> post"; otherwise it falls back to a SEARCH (a Google site:namepros.com
    search for NamePros; a subreddit search for Reddit) and is labeled "find on
    <site>" — a search page is NEVER labeled as a direct post (that mismatch is what
    made the links so confusing). Pass a real `url` OR None; the caller must NOT
    pre-resolve the fallback (that's what defeated the label). A leading ✨ marks a
    MUB (Made-Up Brandable) name (scripts/brandables/PROFILE.md)."""
    from ..filters import mub
    price_str = f" — ${price:,}" if price else ""
    if url:
        post_url, post_label = url, f"{site} post"
    else:
        post_url, post_label = (search_url or SEARCH_URL.format(q=domain)), f"find on {site}"
    return f"• {mub.mub_mark(domain)}{domain}{price_str}  ·  <{post_url}|{post_label}>"


SEEN_FILE = "seen.json"      # cumulative set of domains ever surfaced (net-new gating)
SEEN_CAP = 50_000            # keep the committed state file bounded


def load_seen() -> set[str]:
    data = state.read_json(SOURCE_ID, SEEN_FILE, default={}) or {}
    return {str(d).strip().lower() for d in (data.get("domains") or [])}


def save_seen(seen: set[str]) -> None:
    """Persist the cumulative seen-set (most-recent kept if capped)."""
    domains = sorted(seen)
    if len(domains) > SEEN_CAP:
        domains = domains[-SEEN_CAP:]
    state.write_json(SOURCE_ID, SEEN_FILE, {
        "source": SOURCE_ID,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(domains),
        "domains": domains,
    })


def _sheet_rows(listings: dict[str, int | None], links: dict[str, str], today: str) -> list[dict[str, Any]]:
    return [
        {"domain": d, "price": (listings[d] if listings[d] is not None else ""),
         "source": SOURCE_ID, "date_added": today,
         "link": links.get(d) or SEARCH_URL.format(q=d)}
        for d in sorted(listings, key=lambda d: (listings[d] is None, listings[d] or 0))
    ]


def run() -> int:
    src_cfg = config.get_source(SOURCE_ID)
    reg = config.load_registry()
    snap_cfg = reg["products"]["snap"]
    today = datetime.now(timezone.utc).date().isoformat()

    max_pages = int(os.environ.get("NAMEPROS_MAX_PAGES") or src_cfg.get("max_pages") or 5)
    print(f"[1/4] Fetching NamePros buy-domains via scrape.do (up to {max_pages} page(s))")
    html = _fetch_pages(max_pages)
    listings = extract_listings(html)
    links = extract_links(html)

    # Drill flagged multi-domain bundle threads for inventory hidden in the post
    # body (e.g. alliteration.ai). Capped — each thread is a scrape.do call.
    drill_max = int(os.environ.get("NAMEPROS_DRILL_MAX") or src_cfg.get("drill_max") or 25)
    print(f"[1b/4] Drilling bundle threads (cap {drill_max})")
    drilled = _drill_bundles(html, drill_max)
    added = 0
    for host, (price, url) in drilled.items():
        if host not in listings:
            listings[host] = price
            added += 1
        elif listings[host] is None and price is not None:
            listings[host] = price
        links.setdefault(host, url)
    if added:
        print(f"      bundle drill added {added} domain(s) not in any title")

    # Backfill thread URLs for listings the title parse missed (info-widget / fallback
    # domains), so their Slack/sheet links open the real thread instead of a search page.
    backfill_links(html, listings, links)

    # Net-new gating: only alert on domains we haven't surfaced in a prior run.
    seen = load_seen()
    all_domains = sorted(listings)
    new_listings = {d: listings[d] for d in all_domains if d not in seen}
    priced = {d: p for d, p in new_listings.items() if p}
    domains = sorted(new_listings)
    print(f"      candidates on page: {len(all_domains):,} · net-new (not seen before): "
          f"{len(domains):,} · net-new with asking price: {len(priced):,}")
    if domains:
        print("      sample: " + ", ".join(
            f"{d}" + (f" ${new_listings[d]:,}" if new_listings[d] else "") for d in domains[:40]))
        _dump_price_markup(html, listings)

    probe = [d for d in (os.environ.get("NAMEPROS_PROBE") or "").replace(",", " ").split() if d]
    if probe:
        _probe(html, listings, probe)

    # SNAP Opportunities report + admin drill-down read these.
    state.write_new_today(SOURCE_ID, domains)
    state.write_json(SOURCE_ID, "snapshot.json", listings)
    state.write_json(SOURCE_ID, "links.json", links)  # domain -> NamePros listing URL

    # Good-deals Google Sheet (rebuilt each run). Best-effort: only when an
    # output_sheet_id is configured + shared to the pipeline service account.
    sheet_id = src_cfg.get("output_sheet_id")
    sheet_url = ""
    if sheet_id and domains:
        try:
            sheets_pub.write_rows(
                spreadsheet_id=sheet_id, tab="NamePros",
                mode=sheets_pub.OwnershipMode.REBUILD_OWNED_SLICE, source=SOURCE_ID,
                rows=_sheet_rows(listings, links, today),
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
            # Pass the captured thread URL (or None) — slack_line labels a real thread
            # "NamePros post" and a missing one "find on NamePros" (search). Do NOT
            # pre-resolve the fallback here, or every line gets mislabeled a post.
            lines = [slack_line(d, p, links.get(d)) for d, p in top]
            from ..filters import mub
            mub_n = mub.count_mub(domains)
            text = (f":mag: *NamePros good deals* — {len(domains)} *new* candidate(s) "
                    f"({len(priced)} priced" + (f" · {mub_n} ✨ MUB" if mub_n else "") + ")\n"
                    + "\n".join(lines))
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

    # Remember everything seen on the page (incl. names with no price) so a future
    # run never re-alerts them — net-new only going forward.
    save_seen(seen | set(all_domains))

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID, "label": SOURCE_LABEL, "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(domains), "priced_count": len(priced),
        "candidates_on_page": len(all_domains), "seen_total": len(seen | set(all_domains)),
        "slack_posted": posted,
    })
    print("[4/4] DONE")
    return 0
