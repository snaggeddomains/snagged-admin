"""Shared Slack publisher.

Single entry point for all source-emitted Slack posts. Handles:
  - channel routing (per source via sources.yaml)
  - Block Kit formatting
  - dedupe via fingerprint state (state/<source>/slack_dedupe.json)

Implementation lands with the first source port.
"""
from __future__ import annotations

import os
from typing import Any


def _client():
    from slack_sdk import WebClient
    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError("SLACK_BOT_TOKEN not set")
    return WebClient(token=token)


def post(
    *,
    channel: str,
    text: str,
    blocks: list[dict[str, Any]] | None = None,
    fingerprint: str | None = None,
    source: str | None = None,
) -> None:
    """Post to Slack.

    If `fingerprint` is provided, skips posting when it matches the most recent
    fingerprint in state/<source>/slack_dedupe.json (avoids duplicate Slack
    posts when a workflow retry fires after the underlying snapshot has not
    actually changed).
    """
    raise NotImplementedError("Slack publisher stub — lands with first source port")
