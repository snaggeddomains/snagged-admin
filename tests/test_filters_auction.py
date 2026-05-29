"""Unit tests for the auction listings filter."""
from __future__ import annotations

import pytest

from marketplace_pipeline.filters.auction import passes_auction_filter


@pytest.mark.parametrize("domain,expected", [
    # ----- pass -----
    ("table.com", True),
    ("ocean.io", True),
    ("brand.ai", True),
    ("hello.co", True),
    ("cirro.com", True),                # below SNAP zipf gate but structurally clean
    ("cat.com", True),                  # 3 chars (minimum length)
    ("brandable.com", True),            # 9 chars within range
    # ----- reject: tld -----
    ("trash.xyz", False),
    ("foo.app", False),
    ("foo.dev", False),
    # ----- reject: length -----
    ("ab.com", False),                  # 2 chars, below 3-char min
    ("abcdefghijklmno.com", False),     # 15 chars, above 14-char max
    # ----- reject: structural -----
    ("foo-bar.com", False),             # hyphen
    ("brand7.com", False),              # digit
    ("bcd.com", False),                 # no vowel (and 'y' counts as vowel, so this is consonants only)
    ("pqrstxz.com", False),             # 7-consonant run, no vowel
    # ----- reject: missing -----
    ("", False),
    ("no-tld", False),
])
def test_passes_auction_filter(domain, expected):
    assert passes_auction_filter(domain) is expected


def test_filter_allows_vowel_y():
    # 'y' counts as a vowel
    assert passes_auction_filter("rhythm.com") is True


def test_filter_rejects_long_consonant_run():
    # 5+ consecutive consonants fails
    assert passes_auction_filter("schtchr.com") is False
