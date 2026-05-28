"""Universe ingest filter.

Looser than the daily SNAP filter (standard_listings) — picks what enters
the Tier 3 name universe used for brand-naming workflows. Mirrors the
universe_ingest profile in sources.yaml so the YAML stays the operational
truth and this module enforces it.

Rules (from sources.yaml):
  - TLDs in {.com .ai .io .co .net .org .xyz .app .dev}
  - SLD length 2-14
  - No digits in SLD
  - No hyphens in SLD
  - At least one vowel
  - Max 4 consecutive consonants
"""
from __future__ import annotations

from . import standard as flt

ALLOWED_TLDS: tuple[str, ...] = (
    ".com", ".ai", ".io", ".co", ".net", ".org", ".xyz", ".app", ".dev",
)
SLD_LEN_MIN = 2
SLD_LEN_MAX = 14
VOWELS = frozenset("aeiouy")
MAX_CONSONANT_RUN = 4


def max_consonant_run(sld: str) -> int:
    """Return the longest run of consecutive consonants in sld."""
    run = 0
    longest = 0
    for c in sld.lower():
        if c.isalpha() and c not in VOWELS:
            run += 1
            longest = max(longest, run)
        else:
            run = 0
    return longest


def passes_universe_filter(domain: str) -> bool:
    """Return True if `domain` should be ingested into the Tier 3 universe."""
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
