"""Standard listings filter — strict daily SNAP filter.

Port of legacy/openclaw/scripts/domain_filters.py + word_rules.py with no
behavioral changes. Used by SNAP-product sources for picking what surfaces
to Slack and Sheets. The looser universe_ingest filter (sources.yaml
filter_profiles.universe_ingest) is applied separately for Tier 3 storage.
"""
from __future__ import annotations

import os
from functools import lru_cache

from wordfreq import zipf_frequency

ALLOWED_TLDS: tuple[str, ...] = (".com", ".org", ".net", ".io", ".ai", ".co")
ZIPF_THRESHOLD = 2.8
TLD_ZIPF_OVERRIDES: dict[str, float] = {".io": 3.8, ".net": 5.5}
ROOT_FREQ_THRESHOLD = 2.0
WORD_WHITELIST: set[str] = {"earthling"}
# Plurals used to be dropped outright (looks_plural fires whenever the SINGULAR
# root is common, ignoring the plural's own frequency) — which killed legit
# commerce names like cars/deals/endorsements.com. Now a plural is judged by the
# same dictionary-zipf gate as any word; only re-impose an extra plural bar if
# this is set (0 = no penalty, the default). Past-tense / -ing forms are already
# frequency-aware, so they're unchanged.
PLURAL_MIN_ZIPF = float(os.environ.get("SNAP_PLURAL_MIN_ZIPF") or 0)


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
    z = _freq(lower)
    if lower not in WORD_WHITELIST and z < min_zipf:
        return False
    # Plurals pass on the dictionary-zipf gate (checked above) like any other word —
    # a common plural (cars/deals/endorsements) is a legit name. Only filter weak
    # plurals when SNAP_PLURAL_MIN_ZIPF is set above 0.
    if PLURAL_MIN_ZIPF and looks_plural(lower) and z < PLURAL_MIN_ZIPF:
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


# ── Auction market-signal override ──────────────────────────────────────────
# An auction with real demand/value is proven quality, so a name people are
# actively bidding on is worth surfacing even if its dictionary frequency is below
# the SNAP word cutoff (e.g. sniffle.com — zipf 2.21, but 52 bids / $11k value).
# Still gated to a PREMIUM shape so random/multi-word strings don't ride in on bids.
WORD_ZIPF = 1.5       # a name IS a real word at/above this (sniffle = 2.21)
NEARWORD_ZIPF = 3.0   # an edit-1 target must be a COMMON word (bulls/grill), not rare/proper
AUCTION_MIN_BIDS = int(os.environ.get("AUCTION_MIN_BIDS") or 5)
AUCTION_MIN_PRICE = float(os.environ.get("AUCTION_MIN_PRICE") or 1000)
AUCTION_MIN_VALUATION = float(os.environ.get("AUCTION_MIN_VALUATION") or 10000)


def to_num(x) -> float:
    """Coerce a raw price/bid value ('$1,200', '52', 7, None) to a float (0 on junk)."""
    if x in (None, ""):
        return 0.0
    try:
        return float(str(x).replace("$", "").replace(",", "").strip())
    except (ValueError, TypeError):
        return 0.0


@lru_cache(maxsize=None)
def near_word(sld: str) -> bool:
    """True if `sld` is within one edit (delete/insert/substitute a letter) of a
    common word — a word with a dropped/swapped letter (bullz->bulls, rgrill->grill,
    flickr->flicker). Random consonant strings (pjvf, rhkw, wuex) match nothing."""
    if not (3 <= len(sld) <= 8) or not sld.isalpha():
        return False
    letters = "abcdefghijklmnopqrstuvwxyz"
    for i in range(len(sld)):  # deletions
        if _freq(sld[:i] + sld[i + 1:]) >= NEARWORD_ZIPF:
            return True
    for i in range(len(sld) + 1):  # insertions
        for c in letters:
            if _freq(sld[:i] + c + sld[i:]) >= NEARWORD_ZIPF:
                return True
    for i in range(len(sld)):  # substitutions
        for c in letters:
            if c != sld[i] and _freq(sld[:i] + c + sld[i + 1:]) >= NEARWORD_ZIPF:
                return True
    return False


def premium_shape(domain: str) -> bool:
    """A name worth surfacing on market signal alone: allowed TLD, no hyphen, and
    the SLD is a real word (any length), an LL/LLL string (<=3 letters), a
    word-like brandable (near a common word), or a short number (<=4 digits).
    Excludes random consonant strings and multi-word/long compounds."""
    sld, tld = extract_sld_tld(domain)
    if not sld or not is_allowed_tld(tld) or "-" in sld:
        return False
    if sld.isdigit():
        return len(sld) <= 4
    if sld.isalpha():
        return len(sld) <= 3 or _freq(sld) >= WORD_ZIPF or near_word(sld)
    return False


def market_quality(domain: str, *, bids=0, price=0, valuation=0) -> bool:
    """Premium shape + a real demand/value signal (bids / current bid / valuation)."""
    if not premium_shape(domain):
        return False
    return ((bids or 0) >= AUCTION_MIN_BIDS
            or (price or 0) >= AUCTION_MIN_PRICE
            or (valuation or 0) >= AUCTION_MIN_VALUATION)


def auction_keep(domain: str, *, bids=0, price=0, valuation=0) -> bool:
    """Keep an auction name if it passes the SNAP word filter OR has real market
    signal on a premium shape. Use this in auction sources instead of allow_domain."""
    return allow_domain(domain) or market_quality(domain, bids=bids, price=price, valuation=valuation)
