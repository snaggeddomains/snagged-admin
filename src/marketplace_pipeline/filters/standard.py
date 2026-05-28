"""Standard listings filter — strict daily SNAP filter.

Port of legacy/openclaw/scripts/domain_filters.py + word_rules.py with no
behavioral changes. Used by SNAP-product sources for picking what surfaces
to Slack and Sheets. The looser universe_ingest filter (sources.yaml
filter_profiles.universe_ingest) is applied separately for Tier 3 storage.
"""
from __future__ import annotations

from functools import lru_cache

from wordfreq import zipf_frequency

ALLOWED_TLDS: tuple[str, ...] = (".com", ".org", ".net", ".io", ".ai", ".co")
ZIPF_THRESHOLD = 2.8
TLD_ZIPF_OVERRIDES: dict[str, float] = {".io": 3.8, ".net": 5.5}
ROOT_FREQ_THRESHOLD = 2.0
WORD_WHITELIST: set[str] = {"earthling"}


@lru_cache(maxsize=None)
def _freq(word: str) -> float:
    return zipf_frequency(word, "en") if word else 0.0


def freq(word: str) -> float:
    """Public accessor for the cached zipf frequency."""
    return _freq(word)


def normalize_tld(raw_tld: str) -> str:
    raw_tld = (raw_tld or "").strip().lower()
    if not raw_tld:
        return ""
    return raw_tld if raw_tld.startswith(".") else f".{raw_tld}"


def extract_sld_tld(domain: str) -> tuple[str, str]:
    domain = (domain or "").strip().lower()
    if "." not in domain:
        return domain, ""
    sld, _, tld = domain.partition(".")
    return sld, normalize_tld(tld)


def is_allowed_tld(tld: str) -> bool:
    return normalize_tld(tld) in ALLOWED_TLDS


def min_zipf_for_tld(tld: str) -> float:
    return TLD_ZIPF_OVERRIDES.get(normalize_tld(tld), ZIPF_THRESHOLD)


def is_three_letter_com(sld: str, tld: str) -> bool:
    return (
        len(sld) == 3
        and sld.isascii()
        and sld.isalpha()
        and normalize_tld(tld) == ".com"
    )


def _plural_root_candidates(word: str) -> list[str]:
    lower = word.lower()
    if len(lower) <= 3:
        return []
    cands: list[str] = []
    if lower.endswith("ies"):
        cands.append(lower[:-3] + "y")
    if lower.endswith("ves"):
        cands.append(lower[:-3] + "f")
        cands.append(lower[:-3] + "fe")
    if lower.endswith("oes"):
        cands.append(lower[:-2])
    if lower.endswith("es"):
        cands.append(lower[:-2])
    if lower.endswith("s") and not lower.endswith(("ss", "us", "is")):
        cands.append(lower[:-1])
    return cands


def looks_plural(word: str) -> bool:
    return any(_freq(c) >= ROOT_FREQ_THRESHOLD for c in _plural_root_candidates(word))


def looks_past_tense(word: str, min_zipf: float) -> bool:
    lower = word.lower()
    if len(lower) <= 3:
        return False
    if lower.endswith("ied"):
        return _freq(lower[:-3] + "y") >= ROOT_FREQ_THRESHOLD
    if lower.endswith("ed"):
        # Allow high-frequency words (bored, hacked, etc.).
        return _freq(lower) < min_zipf + 1.0
    return False


def has_progressive_suffix(word: str, min_zipf: float) -> bool:
    lower = word.lower()
    if len(lower) <= 3 or not lower.endswith("ing"):
        return False
    # Allow nouns ending in -ling (earthling, hatchling, etc.)
    if lower.endswith("ling"):
        return False
    # Allow high-frequency words even with -ing
    return _freq(lower) < min_zipf + 1.0


def is_clean_word(word: str, min_zipf: float) -> bool:
    if not word.isalpha():
        return False
    lower = word.lower()
    if lower not in WORD_WHITELIST and _freq(lower) < min_zipf:
        return False
    if looks_plural(lower):
        return False
    if looks_past_tense(lower, min_zipf):
        return False
    if has_progressive_suffix(lower, min_zipf):
        return False
    return True


def passes_word_filter(word: str, min_zipf: float = ZIPF_THRESHOLD) -> bool:
    return bool(word) and word.isalpha() and is_clean_word(word.lower(), min_zipf)


def allow_domain(domain: str) -> bool:
    """Return True if `domain` passes the standard daily SNAP filter."""
    sld, tld = extract_sld_tld(domain)
    if not sld or not is_allowed_tld(tld):
        return False
    if is_three_letter_com(sld, tld):
        return True
    return passes_word_filter(sld, min_zipf_for_tld(tld))
