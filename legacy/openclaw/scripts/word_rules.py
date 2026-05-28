from __future__ import annotations

from functools import lru_cache

from wordfreq import zipf_frequency

ROOT_FREQ_THRESHOLD = 2.0  # minimum Zipf score that counts as a valid English root
WORD_WHITELIST = {"earthling"}


@lru_cache(maxsize=None)
def _freq(word: str) -> float:
    if not word:
        return 0.0
    return zipf_frequency(word, 'en')


def _plural_root_candidates(word: str) -> list[str]:
    lower = word.lower()
    if len(lower) <= 3:
        return []
    cands: list[str] = []
    if lower.endswith('ies') and len(lower) > 3:
        cands.append(lower[:-3] + 'y')
    if lower.endswith('ves') and len(lower) > 3:
        cands.append(lower[:-3] + 'f')
        cands.append(lower[:-3] + 'fe')
    if lower.endswith('oes') and len(lower) > 3:
        cands.append(lower[:-2])
    if lower.endswith('es') and len(lower) > 3:
        cands.append(lower[:-2])
    if lower.endswith('s') and not lower.endswith(('ss', 'us', 'is')):
        cands.append(lower[:-1])
    return cands


def looks_plural(word: str) -> bool:
    for cand in _plural_root_candidates(word):
        if _freq(cand) >= ROOT_FREQ_THRESHOLD:
            return True
    return False


def looks_past_tense(word: str, min_zipf: float) -> bool:
    lower = word.lower()
    if len(lower) <= 3:
        return False
    if lower.endswith('ied') and len(lower) > 3:
        root = lower[:-3] + 'y'
        return _freq(root) >= ROOT_FREQ_THRESHOLD
    if lower.endswith('ed'):
        # Allow high-frequency words (bored, hacked, etc.).
        if _freq(lower) >= min_zipf + 1.0:
            return False
        return True
    return False


def has_progressive_suffix(word: str, min_zipf: float) -> bool:
    lower = word.lower()
    if len(lower) <= 3 or not lower.endswith('ing'):
        return False
    # Allow nouns ending in "ling" (earthling, hatchling, etc.).
    if lower.endswith('ling'):
        return False
    # Allow high-frequency words (common verbs/nouns) even if they end in -ing.
    if _freq(lower) >= min_zipf + 1.0:
        return False
    return True


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
