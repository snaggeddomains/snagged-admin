"""Centralized filtering rules for marketplace + digest outputs."""

from __future__ import annotations

from typing import Iterable, Tuple

from word_rules import is_clean_word

# NOTE: Update these constants once and every importer (fetchers, digests, sheet
# pushers, Slack summaries) will inherit the new rules.
ALLOWED_TLDS: Tuple[str, ...] = (".com", ".org", ".net", ".io", ".ai", ".co")
ALLOWED_STATUSES = {"In Auction", "Pre-Release", "Available Soon"}
ZIPF_THRESHOLD = 2.8
TLD_ZIPF_OVERRIDES = {
    ".io": 3.8,
    ".net": 5.5,
}


def normalize_tld(raw_tld: str) -> str:
    if not raw_tld:
        return ""
    raw_tld = raw_tld.strip().lower()
    if not raw_tld:
        return ""
    return raw_tld if raw_tld.startswith(".") else f".{raw_tld}"


def extract_sld(domain: str) -> tuple[str, str]:
    domain = (domain or "").strip().lower()
    if not domain:
        return "", ""
    if "." not in domain:
        return domain, ""
    sld, _, tld = domain.partition(".")
    return sld, normalize_tld(tld)


def is_allowed_tld(tld: str, allowed: Iterable[str] = ALLOWED_TLDS) -> bool:
    normalized = normalize_tld(tld)
    return bool(normalized) and normalized in tuple(allowed)


def passes_word_filter(word: str, min_zipf: float = ZIPF_THRESHOLD) -> bool:
    return bool(word) and word.isalpha() and is_clean_word(word.lower(), min_zipf)


def min_zipf_for_tld(tld: str, min_zipf: float = ZIPF_THRESHOLD) -> float:
    normalized = normalize_tld(tld)
    return TLD_ZIPF_OVERRIDES.get(normalized, min_zipf)


def is_three_letter_com(sld: str, tld: str) -> bool:
    return len(sld) == 3 and sld.isascii() and sld.isalpha() and normalize_tld(tld) == ".com"



def allow_domain(domain: str,
                 allowed_tlds: Iterable[str] = ALLOWED_TLDS,
                 min_zipf: float = ZIPF_THRESHOLD) -> bool:
    sld, tld = extract_sld(domain)
    if not sld or not is_allowed_tld(tld, allowed_tlds):
        return False
    if is_three_letter_com(sld, tld):
        return True
    threshold = min_zipf_for_tld(tld, min_zipf)
    return passes_word_filter(sld, threshold)
