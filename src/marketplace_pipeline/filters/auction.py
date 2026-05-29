"""Auction listings filter.

Structural filter for the auctions watchlist. Looser than the SNAP
standard_listings filter (no zipf word-frequency gate) but tighter than
universe_ingest. Mirrors the auction_listings profile in sources.yaml.

Rules (from sources.yaml):
  - TLDs in {.com .org .net .io .ai .co}
  - SLD length 3-14
  - No digits in SLD
  - No hyphens in SLD
  - At least one vowel
  - Max 4 consecutive consonants
"""
from __future__ import annotations

from . import standard as flt
from .universe import max_consonant_run

ALLOWED_TLDS: tuple[str, ...] = (".com", ".org", ".net", ".io", ".ai", ".co")
SLD_LEN_MIN = 3
SLD_LEN_MAX = 14
VOWELS = frozenset("aeiouy")
MAX_CONSONANT_RUN = 4


def passes_auction_filter(domain: str) -> bool:
    """Return True if `domain` should surface in the auctions watchlist."""
    sld, tld = flt.extract_sld_tld(domain)
    if not sld or tld not in ALLOWED_TLDS:
        return False
    if not (SLD_LEN_MIN <= len(sld) <= SLD_LEN_MAX):
        return False
    if any(c.isdigit() for c in sld):
        return False
    if "-" in sld:
        return False
    if not any(c in VOWELS for c in sld.lower()):
        return False
    if max_consonant_run(sld) > MAX_CONSONANT_RUN:
        return False
    return True
