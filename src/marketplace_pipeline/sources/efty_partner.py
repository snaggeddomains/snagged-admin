"""Efty partner feed daily ingest + diff.

Combined port of legacy/openclaw/scripts/efty_partner_ingest.py and
efty_partner_diff.py. Fetches the Efty partner CSV feed (handles gzip
encoding), scores each row, ranks 'good deals' via the standard SNAP
filter, diffs against the prior snapshot, and posts a Slack summary
of new + price-changed names to #snap.

The Efty partner token (EFTY_PARTNER_TOKEN env var) is the same secret
already in GH Secrets from earlier setup. No new credentials needed.
"""
from __future__ import annotations

import csv
import gzip
import io
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from .. import config, drive_cache, scoring, state
from ..filters import standard as flt
from ..publishers import slack

SOURCE_ID = "efty_partner"
SOURCE_LABEL = "Efty"

# Efty-specific TLD weights (subset of common SNAP set; .me reintroduced)
TLD_WEIGHTS: dict[str, float] = {
    ".com": 1.0, ".ai": 0.9, ".io": 0.7, ".net": 0.7, ".co": 0.7,
    ".org": 0.6, ".me": 0.4,
}
MIN_PRICE = 1.0
MAX_TOP = 250

DOMAIN_KEYS = ("domain", "name", "domain_name", "fqdn")
PRICE_KEYS = ("price", "bin", "buy_now", "buy_now_price", "asking_price", "amount", "bin_price")
URL_KEYS = ("url", "link", "landing_page", "landing_page_url", "permalink")

FEED_URL_TEMPLATE = "https://efty.com/partner/feed/token/{token}/"
SNAPSHOT_FILE = "snapshot.json"
RAW_FILENAME = "efty_partner.csv"


@dataclass
class ScoredRow:
    domain: str
    price: float
    tld: str
    sld: str
    zipf_score: float
    quality_score: float
    deal_score: float
    link: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "domain": self.domain,
            "price": self.price,
            "tld": self.tld,
            "sld": self.sld,
            "zipf_score": self.zipf_score,
            "quality_score": self.quality_score,
            "deal_score": self.deal_score,
            "link": self.link,
        }


def _tld_weight(tld: str) -> float:
    return TLD_WEIGHTS.get(tld, 0.0)


def _first_value(row: dict[str, str], keys: tuple[str, ...]) -> str:
    lowered = {k.lower(): v for k, v in row.items()}
    for key in keys:
        if key in lowered and str(lowered[key]).strip():
            return str(lowered[key]).strip()
    return ""


def _parse_price(raw: str) -> float:
    raw = (raw or "").strip()
    if not raw:
        return 0.0
    cleaned = raw.replace("$", "").replace(",", "").strip()
    try:
        return float(cleaned)
    except (TypeError, ValueError):
        return 0.0


# ---------- pure helpers ----------

def fetch_feed(token: str) -> bytes:
    """Fetch + transparently decompress the Efty partner CSV feed."""
    url = FEED_URL_TEMPLATE.format(token=token)
    resp = requests.get(
        url,
        timeout=180,
        headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "text/csv,application/octet-stream,*/*",
            "Accept-Encoding": "gzip,deflate",
        },
    )
    if resp.status_code == 429:
        raise RuntimeError("Efty feed returned 429 rate limit")
    resp.raise_for_status()
    content = resp.content
    # requests should auto-decompress when Content-Encoding: gzip, but the
    # legacy also handles the case where the BYTES are gzipped (magic 1f 8b).
    if content[:2] == b"\x1f\x8b":
        try:
            content = gzip.decompress(content)
        except Exception:
            pass
    return content


def decode_csv(raw: bytes) -> list[dict[str, str]]:
    text = raw.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    return [
        {(k or "").strip(): (v or "").strip() for k, v in row.items() if k}
        for row in reader
    ]


def score_row(row: dict[str, str]) -> ScoredRow | None:
    domain = _first_value(row, DOMAIN_KEYS).lower()
    if not domain or "." not in domain:
        return None
    sld, tld = flt.extract_sld_tld(domain)
    link = _first_value(row, URL_KEYS) or f"https://{domain}"
    price = _parse_price(_first_value(row, PRICE_KEYS))
    if price <= 0:
        price = MIN_PRICE
    weight = _tld_weight(tld)
    zipf = flt.freq(sld) if sld else 0.0
    quality = round(zipf * weight, 3)
    deal = round(scoring.deal_score(zipf, price, weight), 1)
    return ScoredRow(
        domain=domain,
        price=price,
        tld=tld,
        sld=sld,
        zipf_score=round(zipf, 3),
        quality_score=quality,
        deal_score=deal,
        link=link,
    )


def rank_good_deals(rows: list[ScoredRow]) -> list[ScoredRow]:
    qualified: list[ScoredRow] = []
    for r in rows:
        if not flt.allow_domain(r.domain):
            continue
        if _tld_weight(r.tld) <= 0:
            continue
        qualified.append(r)
    qualified.sort(
        key=lambda r: (r.deal_score, r.quality_score, r.zipf_score, -r.price),
        reverse=True,
    )
    return qualified


def diff_against_previous(
    current: list[ScoredRow],
    previous_snapshot: list[dict[str, Any]],
) -> dict[str, Any]:
    prev_map = {x["domain"]: x for x in previous_snapshot}
    curr_map = {r.domain: r for r in current}
    new_domains = sorted(curr_map.keys() - prev_map.keys())
    dropped_domains = sorted(prev_map.keys() - curr_map.keys())
    price_changes: list[dict[str, Any]] = []
    for d in curr_map.keys() & prev_map.keys():
        old_price = float(prev_map[d].get("price", 0) or 0)
        new_price = curr_map[d].price
        if round(old_price, 2) != round(new_price, 2):
            price_changes.append({
                "domain": d,
                "old_price": old_price,
                "new_price": new_price,
            })
    new_entries = sorted(
        (curr_map[d] for d in new_domains),
        key=lambda r: r.deal_score,
        reverse=True,
    )
    return {
        "new_entries": new_entries,
        "dropped_domains": dropped_domains,
        "price_changes": price_changes,
    }


def build_slack_message(
    *,
    ranked: list[ScoredRow],
    new_entries: list[ScoredRow],
    dropped_count: int,
    price_change_count: int,
) -> str:
    lines = [
        "Efty partner feed daily ingest is live.",
        f"Ranked good deals: {len(ranked):,}",
        f"New qualifying names: {len(new_entries):,}",
        f"Removals found: {dropped_count:,}",
        f"Price changes: {price_change_count:,}",
    ]
    if new_entries:
        lines.append("")
        lines.append("Top new qualifying names:")
        for e in new_entries[:10]:
            price = f"${e.price:,.0f}" if e.price >= 1000 else f"${e.price:.0f}"
            lines.append(
                f"• {e.domain} — {price} — deal {e.deal_score:.1f} — <{e.link}|link>"
            )
    elif ranked:
        lines.append("")
        lines.append("Top deals overall today:")
        for e in ranked[:10]:
            price = f"${e.price:,.0f}" if e.price >= 1000 else f"${e.price:.0f}"
            lines.append(
                f"• {e.domain} — {price} — deal {e.deal_score:.1f}"
            )
    else:
        lines.append("")
        lines.append("0 met criteria today.")
    return "\n".join(lines)


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    snap_cfg = reg["products"]["snap"]
    slack_channel = os.environ.get(snap_cfg["slack_channel_env"], "C09B1P21YQ0")
    today = datetime.now(timezone.utc).date().isoformat()

    token = os.environ.get("EFTY_PARTNER_TOKEN")
    if not token:
        raise RuntimeError("EFTY_PARTNER_TOKEN must be set in the environment")

    print(f"[1/7] Fetching Efty partner feed")
    raw = fetch_feed(token)
    print(f"      fetched {len(raw):,} bytes")

    print("[2/7] Caching raw to Drive (Tier 2)")
    try:
        file_id = drive_cache.cache_raw(
            source=SOURCE_ID, report_date=today,
            filename=RAW_FILENAME, content=raw,
        )
        print(f"      drive file id: {file_id}")
    except Exception as e:
        print(f"      WARN raw cache write failed (non-fatal): {e}")

    print("[3/7] Decoding CSV + scoring")
    rows = decode_csv(raw)
    scored = [r for r in (score_row(row) for row in rows) if r is not None]
    print(f"      raw rows: {len(rows):,}  scored: {len(scored):,}")

    print("[4/7] Ranking good deals (filter + sort)")
    ranked = rank_good_deals(scored)
    print(f"      qualifying: {len(ranked):,}")

    print("[5/7] Diffing against previous snapshot")
    prev_snapshot = state.read_json(SOURCE_ID, SNAPSHOT_FILE, default=[])
    diff = diff_against_previous(ranked[:MAX_TOP], prev_snapshot)
    print(
        f"      new: {len(diff['new_entries'])}  "
        f"dropped: {len(diff['dropped_domains'])}  "
        f"price changes: {len(diff['price_changes'])}"
    )

    print("[6/7] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, [r.to_dict() for r in ranked[:MAX_TOP]])

    print(f"[7/7] Posting to Slack channel {slack_channel}")
    message = build_slack_message(
        ranked=ranked,
        new_entries=diff["new_entries"],
        dropped_count=len(diff["dropped_domains"]),
        price_change_count=len(diff["price_changes"]),
    )
    posted = slack.post(
        channel=slack_channel,
        text=message,
        dedupe_key=slack.make_fingerprint(message),
        source=SOURCE_ID,
    )
    print(f"      slack posted: {posted}")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "scored_count": len(scored),
        "qualified_count": len(ranked),
        "new_count": len(diff["new_entries"]),
        "dropped_count": len(diff["dropped_domains"]),
        "price_change_count": len(diff["price_changes"]),
        "slack_posted": posted,
    })

    print("DONE")
    return 0
