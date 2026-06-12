"""Part-of-speech tags for a single dictionary-word SLD, from WordNet (free).

Multi-POS by design: a word that is several parts of speech (run/venture/table →
noun + verb, quick → adjective + adverb + noun) gets ALL of them, stored as the
`part_of_speech text[]` column so the naming exercise can filter on it. Returns an
empty list for function words / non-dictionary tokens ("the", "xqz") and whenever
WordNet isn't available — POS is enrichment, it must NEVER break ingest/backfill,
so every failure path fails open to [].

Only meaningful for single dictionary words (num_words == 1); callers pass [] for
two-word concatenations and non-dictionary SLDs.
"""
from __future__ import annotations

from functools import lru_cache

# WordNet POS codes → human labels. 's' (adjective satellite) folds into adjective.
_POS_MAP = {"n": "noun", "v": "verb", "a": "adjective", "s": "adjective", "r": "adverb"}

_WN = None          # the loaded wordnet corpus reader (or None if unavailable)
_WN_TRIED = False   # so we attempt the (slow) load + download at most once


def _wordnet():
    """Lazily import + load WordNet, downloading the corpus once if missing.
    Returns the reader, or None if nltk/WordNet can't be loaded (fail-open)."""
    global _WN, _WN_TRIED
    if _WN is not None or _WN_TRIED:
        return _WN
    _WN_TRIED = True
    try:
        import nltk

        try:
            nltk.data.find("corpora/wordnet")
        except LookupError:
            nltk.download("wordnet", quiet=True)
            nltk.download("omw-1.4", quiet=True)
        from nltk.corpus import wordnet as wn

        wn.ensure_loaded()
        _WN = wn
    except Exception:  # noqa: BLE001 — never let POS enrichment break a run
        _WN = None
    return _WN


@lru_cache(maxsize=200_000)
def pos_tags(word: str) -> tuple[str, ...]:
    """Distinct WordNet parts of speech for a single token, sorted.
    e.g. 'venture' → ('noun','verb'); '' / 'the' / 'qxz' → ()."""
    w = (word or "").strip().lower()
    if not w or not w.isalpha():
        return ()
    wn = _wordnet()
    if wn is None:
        return ()
    try:
        return tuple(sorted({_POS_MAP[s.pos()] for s in wn.synsets(w) if s.pos() in _POS_MAP}))
    except Exception:  # noqa: BLE001 — fail open
        return ()


def pos_for_sld(sld: str, num_words: int | None) -> list[str]:
    """POS list for a name_universe row: WordNet tags for a single dictionary word,
    else [] (two-word concatenations / non-dictionary SLDs don't carry a POS)."""
    if num_words != 1:
        return []
    return list(pos_tags(sld))
