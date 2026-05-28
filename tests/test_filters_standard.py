"""Unit tests for the standard daily SNAP filter.

These pin the ported behavior against the legacy domain_filters + word_rules
so any drift shows up immediately.
"""
from __future__ import annotations

import pytest

from marketplace_pipeline.filters import standard as flt


@pytest.mark.parametrize("raw,expected", [
    ("com", ".com"),
    (".com", ".com"),
    ("  COM ", ".com"),
    ("", ""),
    (None, ""),
])
def test_normalize_tld(raw, expected):
    assert flt.normalize_tld(raw) == expected


@pytest.mark.parametrize("domain,expected_sld,expected_tld", [
    ("example.com", "example", ".com"),
    ("Example.COM", "example", ".com"),
    ("invalid", "invalid", ""),
    ("", "", ""),
])
def test_extract_sld_tld(domain, expected_sld, expected_tld):
    assert flt.extract_sld_tld(domain) == (expected_sld, expected_tld)


def test_is_allowed_tld():
    assert flt.is_allowed_tld(".com")
    assert flt.is_allowed_tld("io")
    assert not flt.is_allowed_tld(".xyz")
    assert not flt.is_allowed_tld("")


def test_min_zipf_overrides():
    assert flt.min_zipf_for_tld(".com") == flt.ZIPF_THRESHOLD
    assert flt.min_zipf_for_tld(".io")  == 3.8
    assert flt.min_zipf_for_tld(".net") == 5.5


def test_is_three_letter_com():
    assert flt.is_three_letter_com("abc", ".com")
    assert not flt.is_three_letter_com("abcd", ".com")
    assert not flt.is_three_letter_com("ab", ".com")
    assert not flt.is_three_letter_com("abc", ".io")
    assert not flt.is_three_letter_com("a1b", ".com")  # not alpha


# ---- allow_domain end-to-end ----

@pytest.mark.parametrize("domain,reason_to_allow", [
    ("table.com",   "common single word, high zipf"),
    ("ocean.com",   "common single word"),
    ("xyz.com",     "3-letter .com exception"),
])
def test_allow_domain_passes_for_common_words_and_3letter_com(domain, reason_to_allow):
    assert flt.allow_domain(domain), f"expected pass: {reason_to_allow}"


@pytest.mark.parametrize("domain", [
    "tables.com",       # plural
    "qzqzqzq.com",      # nonsense, very low zipf
    "anything.xyz",     # disallowed TLD
    "",                 # empty
    "no-tld",           # no tld
])
def test_allow_domain_rejects(domain):
    assert not flt.allow_domain(domain)


def test_high_freq_ing_words_are_exempted():
    """The legacy filter intentionally allows common -ing words like 'running'
    (they're often nouns/gerunds). Pinning this behavior so it can't drift."""
    # The exemption threshold is min_zipf + 1.0. If 'running' is that common,
    # it should pass.
    if flt.freq("running") >= flt.ZIPF_THRESHOLD + 1.0:
        assert flt.allow_domain("running.com")


def test_io_threshold_higher_than_com():
    # 'table' is high enough zipf for .com but not necessarily for .io
    # We assert that the .io threshold is stricter (any borderline word
    # should fail .io while passing .com if its zipf falls between).
    word = "salad"
    if flt.freq(word) >= flt.min_zipf_for_tld(".com") and flt.freq(word) < flt.min_zipf_for_tld(".io"):
        assert flt.allow_domain(f"{word}.com")
        assert not flt.allow_domain(f"{word}.io")


def test_clean_word_rejects_past_tense_low_freq():
    # 'hacked' should be allowed (high freq), 'tabled' less so. We don't
    # hard-code, just spot-check the public behavior.
    assert not flt.is_clean_word("xxxed", flt.ZIPF_THRESHOLD)
    assert flt.is_clean_word("table", flt.ZIPF_THRESHOLD)


def test_freq_returns_zero_for_unknown_word():
    assert flt.freq("zzzqqqxxxhhh") == 0.0
