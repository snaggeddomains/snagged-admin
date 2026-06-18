"""Unit tests for markmonitor pure helpers (domain extraction).

run() does live scrape.do + Supabase and is verified end-to-end via
`pipeline run markmonitor` in the manual workflow.
"""
from __future__ import annotations

from marketplace_pipeline.sources import markmonitor as src


def test_extract_pulls_listing_domains():
    html = """<html><body><div class="grid">
      <a href="/offer/photon.com">Photon.com</a>
      <a href="/offer/zenith.io">Zenith.io</a>
      <span>velocity.ai</span> aperture.com
    </div></body></html>"""
    assert src.extract_domains(html) == ["aperture.com", "photon.com", "velocity.ai", "zenith.io"]


def test_extract_ignores_scripts_styles_head():
    html = (
        "<head><meta content='googleapis.com'></head>"
        "<script>var x='tracker.io'; load('analytics.com')</script>"
        "<style>.b{background:url(cdn.net)}</style>"
        "<body><a href='/o/quartz.com'>Quartz</a></body>"
    )
    assert src.extract_domains(html) == ["quartz.com"]


def test_extract_drops_denylisted_infra_and_social():
    html = (
        "<body><a href='https://www.markmonitor.com/about'>MM</a>"
        "<a href='https://facebook.com/x'>fb</a>"
        "<a href='https://x.com/y'>tw</a>"
        "<span>brightwave.com</span></body>"
    )
    assert src.extract_domains(html) == ["brightwave.com"]


def test_extract_collapses_subdomains_to_registrable_host():
    html = "<body><span>www.lumina.com</span> <span>shop.lumina.com</span></body>"
    assert src.extract_domains(html) == ["lumina.com"]


def test_extract_dedupes_and_lowercases():
    html = "<body>Spark.com SPARK.COM spark.com</body>"
    assert src.extract_domains(html) == ["spark.com"]


def test_listings_capture_price_after_domain():
    assert src.extract_listings("<body>spark.com $12,500</body>") == {"spark.com": 12500}


def test_listings_capture_usd_suffix():
    assert src.extract_listings("<body>shiny.com 5000 USD</body>") == {"shiny.com": 5000}


def test_listings_make_an_offer_has_none_price():
    assert src.extract_listings("<body>nimbus.ai make an offer</body>") == {"nimbus.ai": None}


def test_listings_do_not_borrow_neighbor_price():
    got = src.extract_listings("<body>alpha.com $100 beta.com $9,000</body>")
    assert got == {"alpha.com": 100, "beta.com": 9000}


def test_listings_ignore_bare_numbers_and_years():
    assert src.extract_listings("<body>spark.com founded 2021, 12 sales</body>") == {"spark.com": None}


def test_listings_price_less_row_does_not_borrow_next_rows_price():
    # Real bug: voicemail.com has no price (–); the $10,000 belongs to vvv.us on
    # the NEXT row. .us isn't a core TLD, but it must still bound the price scan.
    html = (
        "<body>"
        "voces.com &ndash; <a>Make Offer</a> "
        "voicemail.com &ndash; <a>Make Offer</a> "
        "vvv.us $10,000 <a>Make Offer</a> "
        "walletpop.com &ndash; <a>Make Offer</a>"
        "</body>"
    )
    got = src.extract_listings(html)
    assert got.get("voicemail.com") is None
    assert got.get("voces.com") is None
    assert got.get("walletpop.com") is None
    # .us is non-core, so it isn't emitted, but its presence fixed the alignment.
    assert "vvv.us" not in got


def test_listings_each_row_keeps_its_own_price():
    html = (
        "<body>"
        "viewvalue.com $5,000 <a>Make Offer</a> "
        "virtual.us $25,000 <a>Make Offer</a> "
        "visto.com $150,000 <a>Make Offer</a> "
        "visto.net $15,000 <a>Make Offer</a> "
        "vistocorp.com $250 <a>Make Offer</a>"
        "</body>"
    )
    got = src.extract_listings(html)
    assert got["viewvalue.com"] == 5000  # not borrowing virtual.us's $25k
    assert got["visto.com"] == 150000
    assert got["visto.net"] == 15000
    assert got["vistocorp.com"] == 250
