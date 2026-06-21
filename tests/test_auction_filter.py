"""Shared auction market-signal override (filters/standard.auction_keep)."""
from __future__ import annotations

from marketplace_pipeline.filters import standard as flt


def test_word_names_pass_regardless_of_signal():
    assert flt.auction_keep("table.com", bids=0, price=0)      # dictionary word
    assert flt.auction_keep("hd.com", bids=0, price=0)         # LL/LLL via allow_domain path


def test_low_freq_word_kept_only_with_signal():
    # 'sniffle' is below the SNAP word cutoff (zipf 2.21) — needs market signal.
    assert not flt.auction_keep("sniffle.com", bids=0, price=0, valuation=0)
    assert flt.auction_keep("sniffle.com", bids=52, price=6100)
    assert flt.auction_keep("sniffle.com", bids=0, price=0, valuation=11033)


def test_near_word_brandable_kept_with_signal():
    assert flt.auction_keep("bullz.com", bids=20, price=2000)   # -> bulls
    assert flt.auction_keep("rgrill.com", bids=20, price=2000)  # -> grill


def test_random_short_and_multiword_rejected_even_with_signal():
    for d in ("pjvf.com", "rhkw.com", "eeyc.com", "wuex.com",       # random consonants
              "worldweathernetwork.org", "marketingresults.com"):    # multi-word compounds
        assert not flt.auction_keep(d, bids=99, price=9000), d


def test_signal_thresholds():
    # Below all thresholds (bids<5, price<1000, valuation<10000) => not kept.
    assert not flt.auction_keep("sniffle.com", bids=4, price=999, valuation=9999)
    assert flt.auction_keep("sniffle.com", bids=5, price=0)


def test_shape_gate_rejects_hyphen_and_bad_tld():
    assert not flt.auction_keep("anti-spiritual.com", bids=99, price=9000)
    assert not flt.auction_keep("sniffle.xyz", bids=99, price=9000)  # .xyz not an allowed auction TLD


def test_to_num_coerces():
    assert flt.to_num("$6,100") == 6100.0
    assert flt.to_num("52") == 52.0
    assert flt.to_num(None) == 0.0
    assert flt.to_num("n/a") == 0.0
