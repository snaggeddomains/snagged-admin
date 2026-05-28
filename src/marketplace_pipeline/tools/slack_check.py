"""Slack auth smoke test.

Verifies SLACK_BOT_TOKEN works and the bot can see the configured channels.
Optionally posts a single test message to confirm posting works end-to-end.

Run via:
    pipeline slack-check                        # auth + reachability only
    pipeline slack-check --post                 # also posts to BOTH configured channels
    pipeline slack-check --post-to C012345      # post only to this channel
"""
from __future__ import annotations

import argparse
import os
import sys


def _client():
    from slack_sdk import WebClient

    token = os.environ.get("SLACK_BOT_TOKEN")
    if not token:
        raise RuntimeError("SLACK_BOT_TOKEN not set")
    return WebClient(token=token)


def _channels_to_check() -> dict[str, str]:
    return {
        "snap":     os.environ.get("SLACK_CHANNEL_SNAP", "C09B1P21YQ0"),
        "auctions": os.environ.get("SLACK_CHANNEL_AUCTIONS", "C096AT8BECS"),
    }


def _check_auth(client) -> None:
    auth = client.auth_test()
    print(
        f"Authenticated as: {auth['user']} (bot id {auth['user_id']}) "
        f"in workspace '{auth['team']}'"
    )
    # Slack returns the token's granted scopes in the X-OAuth-Scopes response
    # header. Surfacing this makes 'missing_scope' errors immediately diagnosable.
    raw = auth.headers.get("x-oauth-scopes", "") if hasattr(auth, "headers") else ""
    scopes = sorted(s.strip() for s in raw.split(",") if s.strip())
    print(f"Granted scopes ({len(scopes)}): {', '.join(scopes) or '(none reported)'}")
    expected = {"chat:write", "chat:write.public", "channels:read"}
    missing = expected - set(scopes)
    if missing:
        print(f"  WARN missing expected scope(s): {', '.join(sorted(missing))}")


def _check_channels(client, channels: dict[str, str]) -> int:
    from slack_sdk.errors import SlackApiError

    failures = 0
    for label, channel_id in channels.items():
        try:
            info = client.conversations_info(channel=channel_id)
            chan = info["channel"]
            member = chan.get("is_member", False)
            marker = "OK  " if member else "WARN"
            print(
                f"  {marker} channel {label:<10} #{chan['name']:<20} ({channel_id})  "
                f"bot_is_member={member}"
            )
            if not member:
                print(f"       -> /invite the bot to #{chan['name']} so it can post")
                failures += 1
        except SlackApiError as e:
            print(f"  FAIL channel {label:<10} ({channel_id})  {e.response['error']}")
            failures += 1
    return failures


def _post_test(client, channel_id: str) -> int:
    from slack_sdk.errors import SlackApiError

    text = ":wave: snagged-admin pipeline auth smoke test — safe to ignore/delete"
    try:
        r = client.chat_postMessage(channel=channel_id, text=text)
        print(f"  OK posted test message to {channel_id} (ts={r['ts']})")
        return 0
    except SlackApiError as e:
        print(f"  FAIL post to {channel_id}: {e.response['error']}")
        return 1


def run(post_all: bool = False, post_to: str | None = None) -> int:
    print("Slack auth smoke test")
    print("=" * 50)
    try:
        client = _client()
        _check_auth(client)
        print()
    except Exception as e:
        print(f"FAIL: {e}")
        return 1

    print("Channel reachability:")
    channels = _channels_to_check()
    chan_fail = _check_channels(client, channels)
    print()

    post_fail = 0
    if post_to:
        print(f"Test post (--post-to {post_to}):")
        post_fail = _post_test(client, post_to)
        print()
    elif post_all:
        print("Test posts to all configured channels:")
        for cid in channels.values():
            post_fail += _post_test(client, cid)
        print()

    total = chan_fail + post_fail
    if total == 0:
        suffix = " + post(s) successful" if (post_all or post_to) else ""
        print(f"PASS -- Slack auth + all channels reachable{suffix}")
        return 0
    print(f"FAIL -- {total} issue(s)")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="slack-check")
    parser.add_argument("--post", action="store_true",
                        help="post a test message to BOTH configured channels")
    parser.add_argument("--post-to", metavar="CHANNEL_ID", default=None,
                        help="post a test message to a single specific channel")
    args = parser.parse_args(argv)
    return run(post_all=args.post, post_to=args.post_to)


if __name__ == "__main__":
    sys.exit(main())
