"""redact_secrets must strip credentials from state JSON before it's committed."""
from __future__ import annotations

from marketplace_pipeline.state import redact_secrets


def test_redacts_scrape_do_token_query_param():
    url = "https://api.scrape.do/?token=c18d01bc2b4c450f99e34c0c8ba33e2805b045c9645&url=https%3A%2F%2Foxley.com&super=true"
    out = redact_secrets({"error": f"502 Server Error: Bad Gateway for url: {url}"})
    assert "c18d01bc2b4c450f99e34c0c8ba33e2805b045c9645" not in out["error"]
    assert "token=***REDACTED***" in out["error"]
    # non-secret params survive
    assert "super=true" in out["error"]


def test_redacts_efty_path_token():
    url = "https://efty.com/partner/feed/token/640677654bf924ed61392d5393d5781db75edfa275cd3b62edc5e390319ed718/"
    out = redact_secrets(url)
    assert "640677654bf924ed61392d5393d5781db75edfa275cd3b62edc5e390319ed718" not in out
    assert "/token/***REDACTED***/" in out


def test_redacts_bearer_header():
    assert redact_secrets("Authorization: Bearer sk-abc123def456ghi") == "Authorization: Bearer ***REDACTED***"


def test_recurses_into_lists_and_dicts():
    out = redact_secrets({"a": ["x=1", "api_key=SEKRET123"], "b": {"c": "key=TOPSECRETVAL"}})
    assert out["a"][0] == "x=1"
    assert "SEKRET123" not in out["a"][1]
    assert "TOPSECRETVAL" not in out["b"]["c"]


def test_leaves_plain_domains_and_prose_untouched():
    data = {"domains": ["secret.com", "token.io", "mykey.net"], "note": "asked for price"}
    assert redact_secrets(data) == data
