"""Quality + deal scoring for marketplace listings.

Port of legacy/openclaw/scripts/score_utils.py plus the TLD weight table
from namecheap_daily_diff.py (the same table is used by Afternic and other
SNAP sources in legacy).
"""
from __future__ import annotations

DEAL_SCORE_SCALE = 10000.0

TLD_WEIGHTS: dict[str, float] = {
    ".com": 1.0,
    ".ai":  0.9,
    ".io":  0.7,
    ".net": 0.7,
    ".co":  0.7,
    ".org": 0.6,
    ".dev": 0.6,
    ".xyz": 0.5,
    ".me":  0.4,
}
# NOTE: every TLD allowed into the universe (filters/universe.ALLOWED_TLDS) MUST
# have an entry here, or its quality_score is 0.0 (tld_weight defaults to 0) and
# the name looks like junk even when it's a clean dictionary word. .dev/.xyz were
# added 2026-06 for exactly that reason — they were scoring 0.0 across the board.


def tld_weight(tld: str) -> float:
    tld = (tld or "").strip().lower()
    if tld and not tld.startswith("."):
        tld = f".{tld}"
    return TLD_WEIGHTS.get(tld, 0.0)


def quality_score(zipf: float, weight: float) -> float:
    """quality = zipf * tld_weight  (higher = better)."""
    return zipf * max(weight, 0.0)


def deal_score(
    zipf: float,
    price: float,
    weight: float,
    scale: float = DEAL_SCORE_SCALE,
) -> float:
    """deal = (zipf * tld_weight) / price * 10000 (higher = better deal).
    Zero if price is non-positive.
    """
    if price <= 0:
        return 0.0
    return (zipf * max(weight, 0.0)) / max(price, 1.0) * scale
