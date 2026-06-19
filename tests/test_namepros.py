"""Pure-helper tests for the NamePros marketplace source (shape filter + parse).

run() does live scrape.do and is validated end-to-end via the manual workflow.
"""
from __future__ import annotations

from marketplace_pipeline.sources import namepros_marketplace as src


def test_shape_accepts_user_examples():
    # Every domain the user called out as qualifying must pass the shape gate.
    for d in ["backup.now", "candy.com", "1882.org", "nondescript.ai", "alliteration.ai"]:
        assert src.shape_ok(d), d


def test_shape_rejects_made_up_brandables():
    # The quality complaint: made-up brandables (not dictionary words) must drop;
    # real single words must pass.
    for d in ["jobonly.com", "preformer.com", "furnishiq.com", "payolia.com",
              "soclear.com", "spectranex.com", "taxbo.com", "hokul.com"]:
        assert not src.shape_ok(d), d
    for d in ["song.com", "lobster.io", "garden.org", "harbor.com"]:
        assert src.shape_ok(d), d


def test_shape_rejects_hyphens_and_long_numbers_and_odd_tlds():
    assert not src.shape_ok("my-domain.com")      # hyphen
    assert not src.shape_ok("123456.com")          # 6-digit number (> short)
    assert not src.shape_ok("backup.zzzz")         # TLD not in the popular/phrase set
    assert not src.shape_ok("garden.cc")           # .cc excluded (low value / bundle flooding)
    assert not src.shape_ok("a1b2.com")            # alnum mix
    assert not src.shape_ok("ab.co.com")           # multi-label host


def test_shape_short_numeric_and_short_alpha():
    assert src.shape_ok("404.io")        # 3-digit
    assert src.shape_ok("1882.org")      # 4-digit
    assert src.shape_ok("hd.com")        # 2 alpha — short premium (.com)
    assert not src.shape_ok("99999999.com")  # 8 digits


def test_short_alpha_premium_is_com_only():
    assert src.shape_ok("xyz.com")       # LLL.com premium kept
    assert src.shape_ok("art.io")        # short but a real word -> kept
    assert not src.shape_ok("rzt.ai")    # random 3-letter non-.com -> dropped
    assert not src.shape_ok("phk.net")   # random 3-letter non-.com -> dropped


def test_extract_listings_pulls_domain_and_nearby_price():
    html = "<div>candy.com $100,000</div><div>garden.org — $325</div><div>harbor.io</div>"
    got = src.extract_listings(html)  # dict host -> price|None
    assert got.get("candy.com") == 100000
    assert got.get("garden.org") == 325
    assert "harbor.io" in got and got["harbor.io"] is None


def test_extract_handles_k_suffix():
    assert src.extract_listings("<p>shiny.ai $2.5k</p>").get("shiny.ai") == 2500


def test_extract_drops_infra_and_keeps_only_shape_passers():
    html = "<a>nameproscdn.com</a> <a>namepros.com</a> <a>my-brand.com</a> <span>candy.com $50</span>"
    got = src.extract_listings(html)
    assert set(got) == {"candy.com"}  # CDN/self + hyphen all dropped


def test_extract_real_namepros_info_block():
    # The real markup: domain title <h3>, then the price in a <ul class="info">,
    # then a data-expires time tag (a unix epoch that must NOT be read as price).
    # An href to the seller profile (a namepros.com URL) sits between title+price
    # and previously truncated the window before the price.
    html = (
        '<h3><a href="https://www.namepros.com/members/x">harbor.org</a></h3>'
        '<ul class="info"><li>Bid</li><li>$605</li>'
        '<li title="Time left"><time data-expires="1782244800">4d 5h</time></li></ul>'
        '<h3><a href="/marketplace/x">backup.now</a></h3>'
        '<ul class="info"><li>BIN</li><li>$777</li></ul>'
    )
    got = src.extract_listings(html)
    assert got.get("harbor.org") == 605   # not 1782244800 (the epoch)
    assert got.get("backup.now") == 777


def test_extract_make_offer_listing_has_no_price():
    html = ('<h3><a>candy.com</a></h3><ul class="info"><li>Make offer</li>'
            '<li><time data-expires="1782244800">2d</time></li></ul>')
    got = src.extract_listings(html)
    assert "candy.com" in got and got["candy.com"] is None


def test_real_listings_drop_page_chrome():
    # When real listings (info widgets) are present, shape-ok domains that are
    # just page chrome (footer/article links with no info widget) are dropped —
    # escrow.com / fontawesome.com must not show up as "good deals".
    html = (
        '<footer><a>escrow.com</a> <a>fontawesome.com</a> <a>domaining.com</a></footer>'
        '<h3><a href="/m/x">garden.com</a></h3>'
        '<ul class="info"><li>Bid</li><li>$29</li>'
        '<li><time data-expires="1782331200">5d</time></li></ul>'
    )
    got = src.extract_listings(html)
    assert set(got) == {"garden.com"}
    assert got["garden.com"] == 29


def test_legacy_fallback_when_no_info_widgets():
    # If the page has NO info widgets at all (markup changed), fall back to the
    # generic nearest-price scan so we never silently return nothing.
    html = "<div>candy.com $50</div>"
    got = src.extract_listings(html)
    assert got.get("candy.com") == 50


# ── Forum thread listings (the PRIMARY format — the good seller posts) ──────────
THREAD_HTML = (
    '<div class="structitem-title">'
    '<a data-preview-url="/threads/backup-now-777-today-only.1390401/preview">'
    'backup.now - $777 today only</a></div>'
    '<div class="structitem-title">'
    '<a data-preview-url="/threads/1882-org-quick-sale.1390356/preview">'
    '1882.org - quick sale</a></div>'
    '<div class="structitem-title">'
    '<a data-preview-url="/threads/nondescript-ai.1389601/preview">'
    'nondescript.ai for $135</a></div>'
)


def test_thread_listings_captured_with_price():
    got = src.extract_listings(THREAD_HTML)
    assert got.get("backup.now") == 777
    assert got.get("nondescript.ai") == 135
    assert "1882.org" in got and got["1882.org"] is None  # "quick sale" — no price


def test_thread_listing_urls():
    links = src.extract_links(THREAD_HTML)
    assert links.get("backup.now") == "https://www.namepros.com/threads/backup-now-777-today-only.1390401"
    assert links.get("1882.org") == "https://www.namepros.com/threads/1882-org-quick-sale.1390356"


def test_thread_drops_made_up_domains_in_title():
    html = ('<a data-preview-url="/threads/x.1/preview">jobonly.com fire sale $99</a>')
    got = src.extract_listings(html)
    assert "jobonly.com" not in got  # not a dictionary word


def test_looks_bundle_flags_multi_domain_titles():
    assert src._looks_bundle(".ai for $135 ushuaia nondescript.ai adriano alliteration")  # .tld for
    assert src._looks_bundle("pick any domain for only $60 7142.net 9645.net")            # 2+ domains
    assert src._looks_bundle("premium .com names lot - dm for list")                       # keyword
    assert not src._looks_bundle("backup.now - $777 today only")                           # single listing


def test_parse_post_domains_extracts_list_with_prices():
    post = ("Selling my .ai bundle: alliteration.ai - $135, nondescript.ai - $135, "
            "and a junk one zzqxw.ai too.")
    got = src._parse_post_domains(post, "https://www.namepros.com/threads/x.1")
    assert got["alliteration.ai"] == (135, "https://www.namepros.com/threads/x.1")
    assert got["nondescript.ai"][0] == 135
    assert "zzqxw.ai" not in got  # not a dictionary word
