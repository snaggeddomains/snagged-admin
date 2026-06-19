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
