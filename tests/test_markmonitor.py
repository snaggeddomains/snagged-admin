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
