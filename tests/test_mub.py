"""MUB ("Made-Up Brandable") filter — see scripts/brandables/PROFILE.md.

Uses real wordfreq (a pipeline dependency) for the made-up check.
"""
from __future__ import annotations

from marketplace_pipeline.filters import mub


def test_in_profile_names_pass():
    for d in ("ambrino.com", "batino.com", "boga.com", "ditora.com", "pentero.com"):
        assert mub.is_mub(d), d


def test_k_and_c_excluded():
    # hard /k/ is K-vs-C ambiguous by ear
    assert not mub.is_mub("kerema.com")
    assert not mub.is_mub("karina.com")


def test_spelling_traps_excluded():
    assert not mub.is_mub("prontus.com")   # back vowel before cluster -> "prawntis"
    assert not mub.is_mub("brandi.com")    # terminal i (Brandi/Brandy)
    assert not mub.is_mub("derosa.com")    # intervocalic s -> /z/
    assert not mub.is_mub("demila.com")    # intervocalic l -> doubling
    assert not mub.is_mub("google.com")    # double letter


def test_negative_and_sensitive_excluded():
    assert not mub.is_mub("detus.com")     # ~fetus
    assert not mub.is_mub("depus.com")     # contains "pus"
    assert not mub.is_mub("habido.com")    # ~libido


def test_real_words_excluded():
    for d in ("table.com", "stripe.com", "sniffle.com"):
        assert not mub.is_mub(d), d


def test_com_only():
    assert not mub.is_mub("vexa.io")
    assert not mub.is_mub("ambrino.net")
    assert not mub.is_mub("ab.co.com")     # multi-label


def test_mark_and_count():
    assert mub.mub_mark("batino.com") == "✨ "
    assert mub.mub_mark("google.com") == ""
    assert mub.count_mub(["ambrino.com", "google.com", "batino.com"]) == 2
