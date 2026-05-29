"""Universe ingest filter.

Picks the candidates that enter the Tier 3 name universe — the searchable
pool the brand-naming workflows query against. This is the universe Phase
1 (Supabase `name_universe` table) reads from when running cross-source
naming queries.

The rule that defines "is this a name worth considering?" has two layers:

  1. Structural rules — TLD in our short list, length 2-14, no digits/
     hyphens, at least one vowel. Cheap to evaluate.
  2. Dictionary-word rule — the SLD must be either a single English
     dictionary word OR two concatenated dictionary words. We use
     wordfreq's zipf frequency as a dictionary proxy (zipf >= 3.0,
     ~1 occurrence per million in English usage).

Two-word recognition means names like 'freshcoffee', 'bluebird',
'cloudkitchen' qualify; single-word names like 'table', 'ocean', 'queue'
qualify; coined / brand names like 'spotify', 'cirro', 'qxz' don't.

Mirrors the universe_ingest profile in sources.yaml so YAML stays the
operational truth and this module enforces it.
"""
from __future__ import annotations

from functools import lru_cache

from . import standard as flt

ALLOWED_TLDS: tuple[str, ...] = (
    ".com", ".co", ".ai", ".net", ".xyz", ".dev", ".org",
)
SLD_LEN_MIN = 2
SLD_LEN_MAX = 14
VOWELS = frozenset("aeiouy")

# wordfreq zipf >= 3.0 corresponds to roughly "appears at least once per
# million words in English usage" — a reasonable dictionary-word floor
# that captures common vocabulary (table, ocean, fresh, coffee) but
# rejects rare / obscure / coined terms (cirro, qrtyz).
DICT_WORD_MIN_ZIPF = 3.0

# Both halves of a 2-word split must be at least this many characters.
# 3 is the threshold that eliminates wordfreq false positives — 2-letter
# fragments like 'ci', 'ro', 'ir' have inflated zipf because they appear
# in abbreviations and codes, causing things like 'cirro' to wrongly
# pass as 'cir' + 'ro'. At 3+ chars we get only real word splits like
# 'fresh' + 'coffee', 'blue' + 'bird', 'ice' + 'box'.
MIN_HALF_LEN = 3


def max_consonant_run(sld: str) -> int:
    """Return the longest run of consecutive consonants in sld.

    Retained as a utility for downstream scoring layers; not enforced
    by the universe filter.
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


@lru_cache(maxsize=4096)
def _zipf(word: str) -> float:
    """Cached zipf lookup — same SLDs come up repeatedly across sources."""
    from wordfreq import zipf_frequency

    return zipf_frequency(word, "en") if word else 0.0


def is_one_or_two_dictionary_words(sld: str, min_zipf: float = DICT_WORD_MIN_ZIPF) -> bool:
    """True if sld is a single dictionary word OR two concatenated dictionary
    words, using wordfreq zipf as the dictionary proxy.

    Examples (with default zipf >= 3.0):
      'table'        → True   (1-word, zipf ~5)
      'freshcoffee'  → True   (2-word: fresh + coffee)
      'bluebird'     → True   (2-word: blue + bird)
      'cirro'        → False  (zipf ~1.1, not common usage)
      'qrtyz'        → False  (not a word, no valid split)
    """
    sld = sld.lower()
    if not sld or not sld.isalpha():
        return False
    if _zipf(sld) >= min_zipf:
        return True
    # Try every 2-word split where each half is at least MIN_HALF_LEN chars.
    for i in range(MIN_HALF_LEN, len(sld) - MIN_HALF_LEN + 1):
        left, right = sld[:i], sld[i:]
        if _zipf(left) >= min_zipf and _zipf(right) >= min_zipf:
            return True
    return False


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
    if not is_one_or_two_dictionary_words(sld):
        return False
    return True
