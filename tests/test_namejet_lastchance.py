"""Unit tests for namejet_lastchance pure helpers.

End-to-end fetch is exercised via the manual workflow trigger against
the live NameJet site; here we cover the helpers and Cloudflare-challenge
detection.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from marketplace_pipeline.sources import namejet_lastchance as src


# ---------- is_cloudflare_challenge ----------

def test_is_cloudflare_challenge_detects_both_markers():
    html = "<html>Just a moment...<script src='challenges.cloudflare.com'></script></html>"
    assert src.is_cloudflare_challenge(html) is True


def test_is_cloudflare_challenge_requires_both_markers():
    # Only one marker — not a challenge
    assert src.is_cloudflare_challenge("Just a moment...") is False
    assert src.is_cloudflare_challenge("challenges.cloudflare.com") is False


def test_is_cloudflare_challenge_false_for_normal_html():
    assert src.is_cloudflare_challenge("<html><body>auctions</body></html>") is False


# ---------- parse helpers ----------

@pytest.mark.parametrize("text,expected", [
    ("$1,250", 1250.0),
    ("$50", 50.0),
    ("", None),
    (None, None),
    ("garbage", None),
])
def test_parse_money(text, expected):
    assert src.parse_money(text) == expected


@pytest.mark.parametrize("text,expected", [
    ("12", 12),
    ("  3  ", 3),
    ("", None),
    (None, None),
    ("not", None),
])
def test_parse_int_str(text, expected):
    assert src.parse_int_str(text) == expected


# ---------- parse_countdown ----------

def test_parse_countdown_hours_and_minutes():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    dt = src.parse_countdown("5h 30m", now_utc=now)
    assert dt == now + timedelta(hours=5, minutes=30)


def test_parse_countdown_only_hours():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    dt = src.parse_countdown("3 hours", now_utc=now)
    assert dt == now + timedelta(hours=3)


def test_parse_countdown_returns_none_for_empty_or_garbage():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    assert src.parse_countdown("", now_utc=now) is None
    assert src.parse_countdown("  ", now_utc=now) is None
    assert src.parse_countdown("unknown", now_utc=now) is None


# ---------- build_page_url ----------

def test_build_page_url_includes_pagination_params():
    url = src.build_page_url(1, 250, 250)
    assert "startIndex=1" in url
    assert "endIndex=250" in url
    assert "rowsPerPage=250" in url
    assert "exclusivestorefront.action" in url


# ---------- parse_rows ----------

def _row_html(domain: str, status: str, closing: str, price: str = "$10", bids: str = "0") -> str:
    return (
        '<tr>'
        f'  <td><a href="/d">{domain}</a></td>'
        f'  <td class="status">{status}</td>'
        f'  <td class="dtOrderBy">{closing}</td>'
        f'  <td><span class="resultsMinimumBid">{price}</span></td>'
        f'  <td><div class="biddersCount">{bids}</div></td>'
        '</tr>'
    )


def _wrap(rows_html: str) -> str:
    return f'<html><body><table id="searchTable"><tbody>{rows_html}</tbody></table></body></html>'


def test_parse_rows_picks_clean_row():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("table.com", "In Auction", "3h 0m", "$50", "2"))
    out = src.parse_rows(html, now=now)
    assert len(out) == 1
    assert out[0]["domain"] == "table.com"
    assert out[0]["price"] == 50.0
    assert out[0]["bid_count"] == 2
    assert out[0]["status"] == "In Auction"
    assert out[0]["platform"] == "NameJet"


def test_parse_rows_skips_disallowed_status():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("table.com", "Closed", "3h 0m"))
    assert src.parse_rows(html, now=now) == []


def test_parse_rows_skips_disallowed_tld():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("trash.xyz", "In Auction", "3h 0m"))
    assert src.parse_rows(html, now=now) == []


def test_parse_rows_skips_beyond_24h():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("table.com", "In Auction", "25h 0m"))  # over horizon
    assert src.parse_rows(html, now=now) == []


def test_parse_rows_skips_when_no_countdown():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("table.com", "In Auction", "unknown"))
    assert src.parse_rows(html, now=now) == []


def test_parse_rows_raises_on_cloudflare_challenge():
    html = "<html>Just a moment...<script src='challenges.cloudflare.com'></script></html>"
    with pytest.raises(src.CloudflareChallengeError):
        src.parse_rows(html)


def test_parse_rows_sorts_by_end_time():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(
        _row_html("later.com", "In Auction", "10h 0m")
        + _row_html("sooner.com", "In Auction", "1h 0m")
    )
    domains = [r["domain"] for r in src.parse_rows(html, now=now)]
    assert domains == ["sooner.com", "later.com"]


def test_parse_rows_handles_pre_release_status():
    now = datetime(2026, 5, 28, 12, 0, tzinfo=timezone.utc)
    html = _wrap(_row_html("table.com", "Pre-Release", "5h 0m"))
    out = src.parse_rows(html, now=now)
    assert len(out) == 1
    assert out[0]["status"] == "Pre-Release"


# ---------- Cloudflare Browser Rendering fallback ----------

def test_fetch_via_cf_raises_when_creds_missing(monkeypatch):
    monkeypatch.delenv("CF_BROWSER_ACCOUNT_ID", raising=False)
    monkeypatch.delenv("CF_BROWSER_API_TOKEN", raising=False)
    with pytest.raises(src.CloudflareChallengeError, match="CF_BROWSER"):
        src.fetch_html_via_cf_browser_rendering("https://x")


def test_fetch_via_cf_posts_to_account_endpoint(monkeypatch):
    captured = {}

    class _Resp:
        status_code = 200
        text = ""
        def json(_self):
            return {"success": True, "result": "<html>OK</html>"}

    def _post(url, *, headers, json, timeout):
        captured["url"] = url
        captured["headers"] = headers
        captured["body"] = json
        return _Resp()

    monkeypatch.setenv("CF_BROWSER_ACCOUNT_ID", "acc123")
    monkeypatch.setenv("CF_BROWSER_API_TOKEN", "tok456")
    import requests as r
    monkeypatch.setattr(r, "post", _post)

    out = src.fetch_html_via_cf_browser_rendering("https://target")
    assert out == "<html>OK</html>"
    assert "acc123" in captured["url"]
    assert "browser-rendering/content" in captured["url"]
    assert captured["headers"]["Authorization"] == "Bearer tok456"
    assert captured["body"]["url"] == "https://target"


def test_fetch_via_cf_raises_on_unsuccessful_response(monkeypatch):
    class _Resp:
        status_code = 200
        text = ""
        def json(_self):
            return {"success": False, "errors": ["denied"]}

    monkeypatch.setenv("CF_BROWSER_ACCOUNT_ID", "acc")
    monkeypatch.setenv("CF_BROWSER_API_TOKEN", "tok")
    import requests as r
    monkeypatch.setattr(r, "post", lambda *_a, **_kw: _Resp())

    with pytest.raises(RuntimeError, match="error"):
        src.fetch_html_via_cf_browser_rendering("https://x")


def test_fetch_html_falls_back_to_cf_on_challenge(monkeypatch):
    """fetch_html sees CF challenge from Playwright, falls back to CF API."""
    challenge_html = "<html>Just a moment...<script src='challenges.cloudflare.com'></script></html>"
    good_html = "<html><body>real content</body></html>"

    monkeypatch.setattr(src, "fetch_html_via_playwright", lambda *_a, **_kw: challenge_html)
    monkeypatch.setattr(src, "fetch_html_via_cf_browser_rendering", lambda *_a, **_kw: good_html)

    out = src.fetch_html("https://x")
    assert out == good_html


def test_fetch_html_returns_playwright_html_when_no_challenge(monkeypatch):
    good_html = "<html><body>real content</body></html>"
    monkeypatch.setattr(src, "fetch_html_via_playwright", lambda *_a, **_kw: good_html)
    out = src.fetch_html("https://x")
    assert out == good_html
