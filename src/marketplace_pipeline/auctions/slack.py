"""Auctions Slack writer.

Formats per-source sections for the daily auctions watchlist message and
posts the consolidated text. For v1 with one producer (Park.io), the message
is a single section; once we have an orchestrator running multiple
producers, it concatenates one section per source into one post.
"""
from __future__ import annotations

from typing import Any

from ..publishers import slack as slack_pub


def format_section(*, label: str, listings: list[dict[str, Any]], top_n: int = 12) -> list[str]:
    """Return a list of message lines for one auction source.

    Lines look like:
        *Park.io* — 47 auctions
        • example.com  $42  ends 2d 3h
        • foo.com      $120 ends 4h 12m
        ...
    """
    lines: list[str] = [f"*{label}* — {len(listings)} auctions"]
    if not listings:
        lines.append("_(none)_")
        return lines

    # Caller is expected to sort by end_time ascending so soonest endings
    # surface first. We don't re-sort here.
    for x in listings[:top_n]:
        price = x.get("price")
        if price is None or price == "":
            price_str = "—"
        else:
            try:
                p = float(price)
                price_str = f"${p:,.0f}" if p >= 1000 else f"${p:.0f}"
            except (TypeError, ValueError):
                price_str = f"${price}"
        time_left = x.get("time_left", "")
        domain = x.get("domain", "")
        link = x.get("link")
        rendered = f"<{link}|{domain}>" if link else domain
        lines.append(f"• {rendered}  {price_str}  ends {time_left}")

    if len(listings) > top_n:
        lines.append(f"… and {len(listings) - top_n} more")
    return lines


def post_consolidated(
    *,
    channel: str,
    source: str,
    sections: list[list[str]],
    sheet_url: str,
    dedupe: bool = True,
) -> bool:
    """Post a consolidated auctions watchlist message to Slack.

    Args:
        channel: Slack channel ID.
        source: source_id for dedupe state path. For single-producer v1 use
            the producer's source_id; for the orchestrator use
            'auctions_publish'.
        sections: list of per-source line groups (from format_section).
        sheet_url: link to the auctions sheet for "Full sheet" footer.
        dedupe: if True, attach a fingerprint so re-runs are skipped.
    """
    body_lines: list[str] = ["Auction watchlist update."]
    body_lines.append("")
    for section in sections:
        body_lines.extend(section)
        body_lines.append("")
    body_lines.append(f"Full sheet: <{sheet_url}|sheet>")
    text = "\n".join(body_lines)

    kwargs: dict[str, Any] = {"channel": channel, "text": text}
    if dedupe:
        kwargs["dedupe_key"] = slack_pub.make_fingerprint(text)
        kwargs["source"] = source

    return slack_pub.post(**kwargs)
