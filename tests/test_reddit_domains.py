"""Pure-helper tests for the Reddit r/Domains source (extract + same filter).

run()/_fetch_json do live network and are validated via the manual workflow.
"""
from __future__ import annotations

from marketplace_pipeline.sources import reddit_domains as src


def _post(title="", selftext="", permalink="/r/Domains/comments/x/post/", flair=""):
    return {"data": {"title": title, "selftext": selftext, "permalink": permalink,
                     "link_flair_text": flair}}


def test_extract_pulls_qualifying_domains_with_price_and_link():
    data = {"data": {"children": [
        _post(title="Selling backup.now - $777 today only", permalink="/r/Domains/comments/a/x/"),
        _post(title="For sale: candy.com", selftext="listing candy.com for $5,000 obo"),
        _post(title="1882.org for sale - taking offers"),
    ]}}
    listings, links = src.extract_listings(data)
    assert listings.get("backup.now") == 777
    assert listings.get("candy.com") == 5000
    assert "1882.org" in listings and listings["1882.org"] is None
    assert links["backup.now"] == "https://www.reddit.com/r/Domains/comments/a/x/"


def test_appraisal_and_discussion_posts_are_skipped():
    # The exact noise the user flagged: not-for-sale posts must not contribute names.
    data = {"data": {"children": [
        _post(title="What do you think these 1990s domains are worth? antivirus.net eindhoven.com"),
        _post(title="Thoughts on .ag domains? I use park.io for parking"),
        _post(title="Rate my brandable: garden.io"),
    ]}}
    listings, _ = src.extract_listings(data)
    assert listings == {}  # all three are appraisal/discussion, not sales


def test_valuation_and_rating_posts_are_skipped():
    # The exact posts Rob flagged (2026-07-30): valuation/rating requests with NO explicit
    # sale phrase must NOT hit SNAP, even though they name a domain.
    data = {"data": {"children": [
        _post(title="What is the rating of a domain name for apartments?",
              selftext="I have a domain name for apartments. 2letters+apartments.com"),
        _post(title="How would you value Finals.io?",
              selftext="I recently acquired Finals.io and would like honest opinions on its value. "
                       "Possible uses include esports, tournaments, sports."),
    ]}}
    listings, _ = src.extract_listings(data)
    assert listings == {}


def test_appraisal_flair_excludes_even_with_price():
    # An "Appraisal" flair is authoritative — even a quoted price is a valuation, not a listing.
    data = {"data": {"children": [
        _post(title="Thoughts on example.com? Paid $500", flair="Appraisal"),
    ]}}
    listings, _ = src.extract_listings(data)
    assert "example.com" not in listings


def test_for_sale_flair_includes():
    data = {"data": {"children": [_post(title="garden.io", flair="For Sale")]}}
    listings, _ = src.extract_listings(data)
    assert "garden.io" in listings


def test_hyphenated_host_does_not_yield_subspan():
    # "anti-spiritual.com" must NOT surface as spiritual.com (the user's example).
    data = {"data": {"children": [_post(title="For sale: anti-spiritual.com BIN $150")]}}
    listings, _ = src.extract_listings(data)
    assert "spiritual.com" not in listings


def test_space_split_domain_is_not_flagged_as_bare_sld():
    # The real post: "for sale: Anti spiritual.com BIN: $150" — the domain is
    # antispiritual.com; we must NOT flag the bare spiritual.com.
    data = {"data": {"children": [_post(title="for sale: Anti spiritual.com BIN: $150")]}}
    listings, _ = src.extract_listings(data)
    assert "spiritual.com" not in listings


def test_multi_domain_sale_list_all_kept():
    # A clean multi-domain sale list must still capture each (the prior token is a
    # domain TLD, not a standalone word).
    data = {"data": {"children": [
        _post(title="For sale: person.com thought.com garden.io - make offer"),
    ]}}
    listings, _ = src.extract_listings(data)
    assert {"person.com", "thought.com", "garden.io"} <= set(listings)


def test_extract_applies_same_shape_filter_and_drops_junk():
    data = {"data": {"children": [
        _post(title="jobonly.com and spectranex.com for sale $100"),  # made-up brandables
        _post(title="my-hyphen.com for sale cheap"),                  # hyphen
        _post(title="garden.io for sale"),                            # real word -> kept
    ]}}
    listings, _ = src.extract_listings(data)
    assert "jobonly.com" not in listings
    assert "spectranex.com" not in listings
    assert "my-hyphen.com" not in listings
    assert "garden.io" in listings


def test_extract_skips_comp_and_brand_mentions():
    data = {"data": {"children": [
        _post(title="protocol.ai for sale",
              selftext="comparable: sold like ebay.com. contact me at bob@gmail.com. Real one: garden.io - $300"),
    ]}}
    listings, _ = src.extract_listings(data)
    assert "ebay.com" not in listings      # platform denylist (shared with NamePros)
    assert "gmail.com" not in listings     # free-email denylist
    assert listings.get("garden.io") == 300


def test_extract_handles_empty():
    assert src.extract_listings({}) == ({}, {})
    assert src.extract_listings({"data": {"children": []}}) == ({}, {})
