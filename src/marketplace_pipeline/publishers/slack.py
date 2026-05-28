"""Shared Slack publisher.

Single entry point for all source-emitted Slack posts. Handles:
  - channel routing (caller passes the channel ID)
  - Block Kit helpers
  - fingerprint dedupe via state/<source>/slack_dedupe.json

The pipeline uses local file-based dedupe (NOT channels:history). On every
run the source computes a fingerprint over its outgoing payload; if the
fingerprint matches the last one written for (source, channel), the post is
skipped. This prevents accidental re-posts when a workflow retry fires
without any real data change.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime, timezone
from typing import Any

from .. import state

DEDUPE_FILE = "slack_dedupe.json"


def _client():
    from slack_sdk import WebClient

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError("SLACK_BOT_TOKEN not set")
    return WebClient(token=token)


def make_fingerprint(payload: Any) -> str:
    """Stable SHA-256 fingerprint of any JSON-serializable payload.
    Sort-key stable so dict ordering does not change the result.
    """
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, default=str).encode()
    ).hexdigest()


def _dedupe_state(source: str) -> dict[str, dict[str, str]]:
    return state.read_json(source, DEDUPE_FILE, default={})


def _is_duplicate(source: str, channel: str, dedupe_key: str) -> bool:
    record = _dedupe_state(source)
    return record.get(channel, {}).get("last_fingerprint") == dedupe_key


def _save_fingerprint(source: str, channel: str, dedupe_key: str) -> None:
    record = _dedupe_state(source)
    record[channel] = {
        "last_fingerprint": dedupe_key,
        "last_posted_at": datetime.now(timezone.utc).isoformat(),
    }
    state.write_json(source, DEDUPE_FILE, record)


def post(
    *,
    channel: str,
    text: str,
    blocks: list[dict[str, Any]] | None = None,
    dedupe_key: str | None = None,
    source: str | None = None,
    client: Any = None,
) -> bool:
    """Post a message to Slack.

    Args:
        channel: Slack channel ID.
        text: Fallback text (required by Slack; used in notifications).
        blocks: Optional Block Kit payload.
        dedupe_key: If provided (with source), skip when this matches the
            most recent fingerprint for (source, channel).
        source: Source ID. Required when dedupe_key is provided so we know
            which state/<source>/slack_dedupe.json to read/write.
        client: Optional pre-built WebClient (for testing).

    Returns:
        True if a message was posted; False if skipped via dedupe.
    """
    if dedupe_key is not None:
        if not source:
            raise ValueError("`source` is required when `dedupe_key` is provided")
        if _is_duplicate(source, channel, dedupe_key):
            return False

    cli = client or _client()
    kwargs: dict[str, Any] = {"channel": channel, "text": text}
    if blocks:
        kwargs["blocks"] = blocks
    cli.chat_postMessage(**kwargs)

    if dedupe_key is not None and source:
        _save_fingerprint(source, channel, dedupe_key)
    return True


# ----- Block Kit helpers -----

def section(text: str) -> dict[str, Any]:
    return {"type": "section", "text": {"type": "mrkdwn", "text": text}}


def divider() -> dict[str, Any]:
    return {"type": "divider"}


def context(text: str) -> dict[str, Any]:
    return {"type": "context", "elements": [{"type": "mrkdwn", "text": text}]}


def header(text: str) -> dict[str, Any]:
    return {"type": "header", "text": {"type": "plain_text", "text": text}}
