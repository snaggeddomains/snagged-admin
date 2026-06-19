"""Pure-helper tests for the Reddit r/Domains source (extract + same filter).

run()/_fetch_json do live network and are validated via the manual workflow.
"""
from __future__ import annotations

from marketplace_pipeline.sources import reddit_domains as src


def _post(title="", selftext="", permalink="/r/Domains/comments/x/post/"):
    return {"data": {"title": title, "selftext": selftext, "permalink": permalink}}


def test_extract_pulls_qualifying_domains_with_price_and_link():
    data = {"data": {"children": [
        _post(title="Selling backup.now - $777 today only", permalink="/r/Domains/comments/a/x/"),
        _post(title="Rate my brandable", selftext="thinking of listing candy.com for $5,000"),
        _post(title="appraisal please for 1882.org"),
    ]}}
    listings, links = src.extract_listings(data)
    assert listings.get("backup.now") == 777
    assert listings.get("candy.com") == 5000
    assert "1882.org" in listings and listings["1882.org"] is None
    assert links["backup.now"] == "https://www.reddit.com/r/Domains/comments/a/x/"


def test_extract_applies_same_shape_filter_and_drops_junk():
    data = {"data": {"children": [
        _post(title="jobonly.com and spectranex.com for sale $100"),  # made-up brandables
        _post(title="my-hyphen.com cheap"),                            # hyphen
        _post(title="garden.io available"),                            # real word -> kept
    ]}}
    listings, _ = src.extract_listings(data)
    assert "jobonly.com" not in listings
    assert "spectranex.com" not in listings
    assert "my-hyphen.com" not in listings
    assert "garden.io" in listings


def test_extract_skips_comp_and_brand_mentions():
    data = {"data": {"children": [
        _post(title="protocol.ai for sale",
              selftext="comparable: sold like ebay.com and reddit.com. Real one: garden.io - $300"),
    ]}}
    listings, _ = src.extract_listings(data)
    assert "ebay.com" not in listings      # platform denylist (shared with NamePros)
    assert listings.get("garden.io") == 300


def test_extract_handles_empty():
    assert src.extract_listings({}) == ({}, {})
    assert src.extract_listings({"data": {"children": []}}) == ({}, {})
