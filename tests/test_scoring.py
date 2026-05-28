"""Unit tests for quality + deal scoring."""
from __future__ import annotations

import pytest

from marketplace_pipeline import scoring


@pytest.mark.parametrize("tld,expected", [
    (".com", 1.0),
    ("com",  1.0),
    (".ai",  0.9),
    (".io",  0.7),
    (".org", 0.6),
    (".xyz", 0.0),
    ("",     0.0),
])
def test_tld_weight(tld, expected):
    assert scoring.tld_weight(tld) == expected


def test_quality_score_is_zipf_times_weight():
    assert scoring.quality_score(5.0, 1.0) == pytest.approx(5.0)
    assert scoring.quality_score(5.0, 0.7) == pytest.approx(3.5)
    assert scoring.quality_score(0.0, 1.0) == 0.0
    assert scoring.quality_score(5.0, -1.0) == 0.0  # weight floored at 0


def test_deal_score_formula():
    # deal = (zipf * weight) / max(price, 1) * 10000
    # zipf=5, weight=1.0, price=100 -> 5/100*10000 = 500
    assert scoring.deal_score(5.0, 100.0, 1.0) == pytest.approx(500.0)
    # zipf=4, weight=0.7, price=200 -> 2.8/200*10000 = 140
    assert scoring.deal_score(4.0, 200.0, 0.7) == pytest.approx(140.0)


def test_deal_score_zero_when_non_positive_price():
    assert scoring.deal_score(5.0, 0.0, 1.0) == 0.0
    assert scoring.deal_score(5.0, -1.0, 1.0) == 0.0


def test_deal_score_floors_price_at_one():
    # Price 0.5 should be treated as 1.0 to avoid blow-up
    assert scoring.deal_score(5.0, 0.5, 1.0) == pytest.approx(50000.0)
