"""Pure-helper tests for the NamePros marketplace source (shape filter + parse).

run() does live scrape.do and is validated end-to-end via the manual workflow.
"""
from __future__ import annotations

from marketplace_pipeline.sources import namepros_marketplace as src


def test_shape_accepts_user_examples():
    # Every domain the user called out as qualifying must pass the shape gate.
    for d in ["backup.now", "candy.com", "1882.org", "nondescript.ai", "alliteration.ai"]:
        assert src.shape_ok(d), d


def test_shape_rejects_hyphens_and_long_numbers_and_odd_tlds():
    assert not src.shape_ok("my-domain.com")      # hyphen
    assert not src.shape_ok("123456.com")          # 6-digit number (> short)
    assert not src.shape_ok("backup.zzzz")         # TLD not in the popular/phrase set
    assert not src.shape_ok("a1b2.com")            # alnum mix
    assert not src.shape_ok("ab.co.com")           # multi-label host


def test_shape_short_numeric_and_short_alpha():
    assert src.shape_ok("404.io")        # 3-digit
    assert src.shape_ok("1882.org")      # 4-digit
    assert src.shape_ok("hd.com")        # 2 alpha
    assert not src.shape_ok("99999999.com")  # 8 digits


def test_extract_listings_pulls_domain_and_nearby_price():
    html = "<div>candy.com $100,000</div><div>1882.org — $325</div><div>plainword.io</div>"
    got = src.extract_listings(html)  # dict host -> price|None
    assert got.get("candy.com") == 100000
    assert got.get("1882.org") == 325
    assert "plainword.io" in got and got["plainword.io"] is None


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
        '<h3><a href="https://www.namepros.com/members/x">voirdrama.org</a></h3>'
        '<ul class="info"><li>Bid</li><li>$605</li>'
        '<li title="Time left"><time data-expires="1782244800">4d 5h</time></li></ul>'
        '<h3><a href="/marketplace/x">backup.now</a></h3>'
        '<ul class="info"><li>BIN</li><li>$777</li></ul>'
    )
    got = src.extract_listings(html)
    assert got.get("voirdrama.org") == 605   # not 1782244800 (the epoch)
    assert got.get("backup.now") == 777


def test_extract_make_offer_listing_has_no_price():
    html = ('<h3><a>candy.com</a></h3><ul class="info"><li>Make offer</li>'
            '<li><time data-expires="1782244800">2d</time></li></ul>')
    got = src.extract_listings(html)
    assert "candy.com" in got and got["candy.com"] is None
