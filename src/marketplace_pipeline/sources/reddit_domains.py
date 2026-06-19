"""Reddit r/Domains monitor — flag domains posted there that meet our buy criteria.

People post domains for sale / open to offers (and appraisal requests) on
r/Domains all day. This watches the subreddit's newest posts and surfaces the
ones that pass the SAME buy-criteria filter as the NamePros source (popular TLD,
no hyphen, single dictionary word or short premium), publishing them as daily
"good deals":
  • the per-source `new_today` feed → the SNAP Opportunities report,
  • a Google Sheet (when an output_sheet_id is configured),
  • a Slack post to the SNAP channel each run.

Reuses NamePros' shape filter + price/comp helpers verbatim so the criteria stay
identical. Reddit's public JSON is fetched directly (with a descriptive
User-Agent); datacenter IPs are sometimes blocked, so it falls back to scrape.do.

Requires SCRAPE_DO_TOKEN only as the fallback (+ SLACK_BOT_TOKEN for Slack).
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, state
from ..usage_log import record_usage
from ..publishers import sheets as sheets_pub
from ..publishers import slack as slack_pub
# Identical buy criteria + parsing helpers as the NamePros source.
from .namepros_marketplace import shape_ok, _find_price, DOMAIN_RE, COMP_CONTEXT_RE

SOURCE_ID = "reddit_domains"
SOURCE_LABEL = "Reddit r/Domains"
SOURCE_TIER = 2

SUBREDDIT_JSON = "https://www.reddit.com/r/Domains/new.json?limit=100&raw_json=1"
PERMALINK_BASE = "https://www.reddit.com"
SCRAPE_DO_BASE = "https://api.scrape.do/"
UA = "snagged-domain-monitor/1.0 (+https://research.snagged.com)"


def _fetch_json() -> dict:
    """Reddit listing JSON — direct with a real UA, falling back to scrape.do when
    the datacenter IP is blocked (403/429)."""
    try:
        r = requests.get(SUBREDDIT_JSON, headers={"User-Agent": UA}, timeout=30)
        if r.status_code == 200 and r.text.lstrip().startswith("{"):
            print(f"      reddit ok direct ({len(r.text):,} bytes)")
            return r.json()
        print(f"      reddit direct status {r.status_code} — trying scrape.do")
    except Exception as e:  # noqa: BLE001
        print(f"      reddit direct failed: {e} — trying scrape.do")
    token = os.environ.get("SCRAPE_DO_TOKEN")
    if not token:
        raise RuntimeError("reddit direct blocked and no SCRAPE_DO_TOKEN for fallback")
    resp = requests.get(SCRAPE_DO_BASE,
                        params={"token": token, "url": SUBREDDIT_JSON, "super": "true", "geoCode": "us"},
                        timeout=90)
    resp.raise_for_status()
    record_usage("scrape_do.request", 1, "snap")
    print(f"      reddit ok via scrape.do ({len(resp.text):,} bytes)")
    return json.loads(resp.text)


def extract_listings(data: dict) -> tuple[dict[str, int | None], dict[str, str]]:
    """From the subreddit JSON → ({domain: price|None}, {domain: post_url}).
    Scans each post's title + body for shape-ok domains (same filter as NamePros),
    skipping comp/reference mentions; price is the nearest amount after the domain;
    the link is the Reddit post permalink. Deduped (first non-null price wins)."""
    posts = (((data or {}).get("data") or {}).get("children")) or []
    listings: dict[str, int | None] = {}
    links: dict[str, str] = {}
    for ch in posts:
        p = (ch or {}).get("data") or {}
        permalink = PERMALINK_BASE + (p.get("permalink") or "")
        text = f"{p.get('title') or ''}\n{p.get('selftext') or ''}"
        for dm in DOMAIN_RE.finditer(text):
            host = dm.group(1).lower().lstrip(".")
            if not shape_ok(host):
                continue
            if COMP_CONTEXT_RE.search(text[max(0, dm.start() - 40):dm.start()]):
                continue  # "sold like <host>" / "comparable to <host>" — a reference
            price = _find_price(text[dm.end():dm.end() + 120])
            if host not in listings:
                listings[host] = price
                links[host] = permalink
            elif listings[host] is None and price is not None:
                listings[host] = price
    return listings, links


def _sheet_rows(listings: dict[str, int | None], links: dict[str, str], today: str) -> list[dict[str, Any]]:
    return [
        {"domain": d, "price": (listings[d] if listings[d] is not None else ""),
         "source": SOURCE_ID, "date_added": today, "link": links.get(d, "")}
        for d in sorted(listings, key=lambda d: (listings[d] is None, listings[d] or 0))
    ]


def run() -> int:
    src_cfg = config.get_source(SOURCE_ID)
    reg = config.load_registry()
    snap_cfg = reg["products"]["snap"]
    today = datetime.now(timezone.utc).date().isoformat()

    print("[1/4] Fetching r/Domains newest posts")
    data = _fetch_json()
    listings, links = extract_listings(data)
    priced = {d: p for d, p in listings.items() if p}
    domains = sorted(listings)
    print(f"      good-deal candidates: {len(domains):,} · with asking price: {len(priced):,}")
    if domains:
        print("      sample: " + ", ".join(
            f"{d}" + (f" ${listings[d]:,}" if listings[d] else "") for d in domains[:40]))

    # SNAP Opportunities report + admin drill-down read these.
    state.write_new_today(SOURCE_ID, domains)
    state.write_json(SOURCE_ID, "snapshot.json", listings)
    state.write_json(SOURCE_ID, "links.json", links)  # domain -> Reddit post URL

    # Good-deals Google Sheet (rebuilt each run). Best-effort: only when an
    # output_sheet_id is configured + shared to the pipeline service account.
    sheet_id = src_cfg.get("output_sheet_id")
    sheet_url = ""
    if sheet_id and domains:
        try:
            sheets_pub.write_rows(
                spreadsheet_id=sheet_id, tab="Reddit",
                mode=sheets_pub.OwnershipMode.REBUILD_OWNED_SLICE, source=SOURCE_ID,
                rows=_sheet_rows(listings, links, today),
                default_header=["domain", "price", "link", "source", "date_added"],
            )
            sheet_url = f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
            print(f"[2/4] Wrote {len(domains):,} rows to the good-deals sheet")
        except Exception as e:  # noqa: BLE001
            print(f"[2/4] Sheet write skipped: {e}")
    else:
        print("[2/4] No output_sheet_id set yet — skipping sheet (create one, share to the SA, add the id)")

    # Slack to the SNAP channel each run.
    posted = False
    if domains and os.environ.get("SLACK_BOT_TOKEN"):
        channel = os.environ.get(snap_cfg.get("slack_channel_env", ""), "") or os.environ.get("SLACK_CHANNEL_SNAP", "")
        if channel:
            top = sorted(priced.items(), key=lambda kv: kv[1])[:15] if priced else [(d, None) for d in domains[:15]]
            lines = [f"• {d}" + (f" — ${p:,}" if p else "") for d, p in top]
            text = (f":mag: *r/Domains good deals* — {len(domains)} candidate(s) today "
                    f"({len(priced)} priced)\n" + "\n".join(lines))
            if sheet_url:
                text += f"\n<{sheet_url}|Full list →>"
            try:
                posted = slack_pub.post(channel=channel, source=SOURCE_ID, text=text,
                                        dedupe_key=slack_pub.make_fingerprint(text))
                print(f"[3/4] Slack posted to {channel}: {posted}")
            except Exception as e:  # noqa: BLE001
                print(f"[3/4] Slack post skipped: {e}")
        else:
            print("[3/4] No SNAP Slack channel configured — skipping Slack")
    else:
        print("[3/4] Slack skipped (no candidates or SLACK_BOT_TOKEN)")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID, "label": SOURCE_LABEL, "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": len(domains), "priced_count": len(priced),
        "slack_posted": posted,
    })
    print("[4/4] DONE")
    return 0
