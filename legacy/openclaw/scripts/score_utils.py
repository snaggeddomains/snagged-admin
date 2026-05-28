#!/usr/bin/env python3
from __future__ import annotations

DEAL_SCORE_SCALE = 10000.0


def scale_deal_score(raw_score: float, scale: float = DEAL_SCORE_SCALE) -> float:
    return raw_score * scale


def compute_deal_score(zipf: float, price: float, tld_weight: float, scale: float = DEAL_SCORE_SCALE) -> float:
    if price <= 0:
        return 0.0
    return scale_deal_score((zipf * max(tld_weight, 0.0)) / max(price, 1.0), scale=scale)
