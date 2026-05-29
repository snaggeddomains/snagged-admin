"""Universe ingest filter.

The broad filter that decides which names are admitted into the Tier 3
name universe — the searchable pool the brand-naming workflows query
against. Intentionally permissive: we only reject structural junk
(numbers, hyphens, no vowel at all). All quality-based ranking
(zipf, length, category fit, price) is applied later by the naming
exercise, not here.

Mirrors the universe_ingest profile in sources.yaml so YAML stays the
operational truth and this module enforces it.

Rules:
  - TLDs in {.com .co .ai .net .xyz .dev .org}
  - SLD length 2-14
  - No digits in SLD
  - No hyphens in SLD
  - At least one vowel (rejects pure keyboard-mash)
"""
from __future__ import annotations

from . import standard as flt

ALLOWED_TLDS: tuple[str, ...] = (
    ".com", ".co", ".ai", ".net", ".xyz", ".dev", ".org",
)
SLD_LEN_MIN = 2
SLD_LEN_MAX = 14
VOWELS = frozenset("aeiouy")


def max_consonant_run(sld: str) -> int:
    """Return the longest run of consecutive consonants in sld.

    Retained as a utility (used by some downstream scoring) but no longer
    enforced as a filter rule — the universe is meant to be broad.
    """
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
    return True
