"""Unit tests for the shared Slack publisher."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from marketplace_pipeline import state
from marketplace_pipeline.publishers import slack as pub


@pytest.fixture(autouse=True)
def isolate_state(tmp_path, monkeypatch):
    """Redirect state directory to a tmp path so tests do not touch repo state/."""
    monkeypatch.setattr(state, "STATE_DIR", tmp_path)


def test_post_calls_slack_with_text_and_blocks():
    client = MagicMock()
    posted = pub.post(
        channel="C123",
        text="hi",
        blocks=[pub.section("hello")],
        client=client,
    )
    assert posted is True
    kwargs = client.chat_postMessage.call_args.kwargs
    assert kwargs["channel"] == "C123"
    assert kwargs["text"] == "hi"
    assert kwargs["blocks"] == [
        {"type": "section", "text": {"type": "mrkdwn", "text": "hello"}}
    ]


def test_post_without_blocks_omits_blocks_kwarg():
    client = MagicMock()
    pub.post(channel="C123", text="hi", client=client)
    assert "blocks" not in client.chat_postMessage.call_args.kwargs


def test_dedupe_skips_repeat_post_for_same_key():
    client = MagicMock()
    key = pub.make_fingerprint({"items": ["a", "b"]})

    first = pub.post(channel="C1", text="t", dedupe_key=key, source="src1", client=client)
    second = pub.post(channel="C1", text="t", dedupe_key=key, source="src1", client=client)

    assert first is True
    assert second is False
    client.chat_postMessage.assert_called_once()


def test_dedupe_is_per_channel():
    client = MagicMock()
    key = pub.make_fingerprint({"x": 1})

    pub.post(channel="C1", text="t", dedupe_key=key, source="src1", client=client)
    posted2 = pub.post(channel="C2", text="t", dedupe_key=key, source="src1", client=client)

    assert posted2 is True
    assert client.chat_postMessage.call_count == 2


def test_dedupe_is_per_source():
    client = MagicMock()
    key = pub.make_fingerprint({"x": 1})

    pub.post(channel="C1", text="t", dedupe_key=key, source="src1", client=client)
    posted2 = pub.post(channel="C1", text="t", dedupe_key=key, source="src2", client=client)

    assert posted2 is True
    assert client.chat_postMessage.call_count == 2


def test_dedupe_state_persisted_to_disk():
    client = MagicMock()
    key = pub.make_fingerprint({"items": ["a"]})

    pub.post(channel="C1", text="t", dedupe_key=key, source="src1", client=client)

    record = state.read_json("src1", "slack_dedupe.json", default=None)
    assert record["C1"]["last_fingerprint"] == key
    assert "last_posted_at" in record["C1"]


def test_different_fingerprint_posts_again():
    client = MagicMock()
    k1 = pub.make_fingerprint({"x": 1})
    k2 = pub.make_fingerprint({"x": 2})

    pub.post(channel="C1", text="t", dedupe_key=k1, source="src1", client=client)
    posted2 = pub.post(channel="C1", text="t", dedupe_key=k2, source="src1", client=client)

    assert posted2 is True
    assert client.chat_postMessage.call_count == 2


def test_dedupe_key_without_source_raises():
    client = MagicMock()
    with pytest.raises(ValueError, match="source"):
        pub.post(channel="C1", text="t", dedupe_key="abc", client=client)


def test_make_fingerprint_is_order_independent():
    k1 = pub.make_fingerprint({"a": 1, "b": [1, 2]})
    k2 = pub.make_fingerprint({"b": [1, 2], "a": 1})
    assert k1 == k2


def test_block_helpers():
    assert pub.section("x") == {"type": "section", "text": {"type": "mrkdwn", "text": "x"}}
    assert pub.divider() == {"type": "divider"}
    assert pub.context("x") == {
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": "x"}],
    }
    assert pub.header("x") == {"type": "header", "text": {"type": "plain_text", "text": "x"}}
