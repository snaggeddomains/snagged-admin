#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
from pathlib import Path
from domain_filters import allow_domain
import requests

from datetime import datetime
from zoneinfo import ZoneInfo

TZ_ET = ZoneInfo("America/New_York")

def to_et(ts: str | None) -> str:
    if not ts:
        return "—"
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        et = dt.astimezone(TZ_ET)
        return et.strftime("%-m/%-d %-I:%M %p ET")
    except Exception:
        return str(ts)

BASE = Path("/root/.openclaw/workspace")
TOKEN_PATH = BASE / ".secrets/slack-bot-token.txt"
STATUS_PATH = BASE / "data/auction_refresh_status.json"
DRIVE_UPLOADS_PATH = BASE / "data/drive_uploads_filtered.json"
EFTY_DIFF_PATH = BASE / "data/efty_partner_diff.json"
EFTY_LATEST_CSV_PATH = BASE / "data/efty_partner_latest.csv"
CHANNEL = "C096AT8BECS"  # #auctions


def format_price(value) -> str:
    if value in (None, ""):
        return "—"
    try:
        num = float(value)
    except (TypeError, ValueError):
        return str(value)
    if num.is_integer():
        return f"${int(num):,}"
    return f"${num:,.2f}".rstrip("0").rstrip(".")


def format_bids(value) -> str:
    if value in (None, ""):
        return "— bids"
    try:
        num = int(value)
    except (TypeError, ValueError):
        return f"{value} bids"
    return f"{num} bids"


def normalize_price_value(value) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        try:
            return float(str(value).replace("$", "").replace(",", ""))
        except (TypeError, ValueError):
            return None


def format_link(url: str | None) -> str:
    if not url:
        return "link unavailable"
    return f"<{url}|link>"


def render_row(domain: str, end_ts: str | None, price, bids, url: str | None) -> str:
    return (
        f"{domain} - {to_et(end_ts)} - {format_price(price)} - "
        f"{format_bids(bids)} - {format_link(url)}"
    )


def bucket_lines(items: list[dict]) -> list[str]:
    if not items:
        return []

    buckets: dict = {}
    for item in items:
        dt = item.get("et_dt")
        key = dt.date() if dt else None
        buckets.setdefault(key, []).append(item)

    ordered_keys = sorted([key for key in buckets.keys() if key is not None])
    if None in buckets:
        ordered_keys.append(None)

    fallback_dt = datetime.max.replace(tzinfo=TZ_ET)
    lines: list[str] = []
    for idx, key in enumerate(ordered_keys):
        bucket_items = buckets[key]
        bucket_items.sort(
            key=lambda it: (
                -(it.get("price_value") if it.get("price_value") is not None else -1),
                it.get("et_dt") or fallback_dt,
                it.get("domain") or "",
            )
        )
        if idx > 0:
            lines.append("")
        lines.extend(item["line"] for item in bucket_items)
    return lines


def parse_et_datetime(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
        return dt.astimezone(TZ_ET)
    except Exception:
        return None


def load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:
        return None


def load_refresh_status() -> dict[str, dict]:
    data = load_json(STATUS_PATH)
    if not isinstance(data, dict):
        return {}
    sources = data.get("sources")
    if not isinstance(sources, dict):
        return {}
    return {
        str(key): value
        for key, value in sources.items()
        if isinstance(value, dict)
    }


def render_source_state(refresh_status: dict[str, dict], key: str) -> list[str] | None:
    meta = refresh_status.get(key) or {}
    status = str(meta.get("status") or "").lower()
    detail = str(meta.get("detail") or "").strip()
    if status == "failed":
        note = "• Refresh failed for this run, skipped stale data"
        if detail:
            note = f"{note} ({detail})"
        return [note]
    if status in {"disabled", "skipped"}:
        note = "• Refresh skipped for this run"
        if detail:
            note = f"{note} ({detail})"
        return [note]
    return None


def get_failed_sources(refresh_status: dict[str, dict]) -> list[str]:
    hidden_keys = {"drive_uploads", "namejet_lastchance", "namejet_email", "namejet_exclusive"}
    failed = []
    for key, meta in refresh_status.items():
        if key in hidden_keys:
            continue
        if str(meta.get("status") or "").lower() != "failed":
            continue
        failed.append(str(meta.get("label") or key))
    return failed


def build_section(refresh_status: dict[str, dict], title: str, key: str, formatter) -> list[str]:
    section = [title]
    override = render_source_state(refresh_status, key)
    if override is not None:
        section.extend(override)
    else:
        section.extend(formatter())
    section.append("")
    return section


def format_namecheap() -> list[str]:
    path = BASE / "namecheap_auctions_latest.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("matches", [])
    if not rows:
        return ["• No qualifying names found"]

    def sort_key(row: dict) -> tuple:
        bids_raw = row.get("bidCount") or 0
        try:
            bids = int(bids_raw)
        except (ValueError, TypeError):
            bids = 0
        price_raw = row.get("price") or 0
        try:
            price = float(price_raw)
        except (ValueError, TypeError):
            price = 0.0
        return (-bids, -price, row.get("endDate") or "", row.get("domain", ""))

    rows_sorted = sorted(rows, key=sort_key)

    items = []
    for row in rows_sorted:
        domain = row.get("domain", "unknown")
        end = row.get("endDate", "")
        link = row.get("url") or (f"https://www.namecheap.com/market/{domain}/" if domain else None)
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), row.get("bidCount"), link),
            }
        )
    return bucket_lines(items)


def format_drive_uploads() -> list[str]:
    data = load_json(DRIVE_UPLOADS_PATH)
    if not isinstance(data, dict):
        return ["• No data found"]
    rows = data.get('rows', [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows[:100]:
        domain = row.get('domain', 'unknown')
        end = row.get('closing_dt_utc')
        link = row.get('link') or row.get('source_link')
        source_file = row.get('source_file') or 'upload'
        line = render_row(domain, end, row.get('min_bid_value'), row.get('bidders'), link)
        line = f"{line} - {source_file}"
        items.append(
            {
                'domain': domain,
                'et_dt': parse_et_datetime(end),
                'price_value': normalize_price_value(row.get('min_bid_value')),
                'line': line,
            }
        )
    return bucket_lines(items)


def format_dropcatch() -> list[str]:
    path = BASE / "dropcatch_auctions_latest.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("auctions", [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows:
        domain = row.get("domain", "unknown")
        link = row.get("sourceUrl") or (f"https://www.dropcatch.com/product/{domain}" if domain else None)
        end = row.get("endDate")
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), row.get("bids"), link),
            }
        )
    return bucket_lines(items)


def format_parkio() -> list[str]:
    path = BASE / "parkio_auctions_latest.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("auctions", [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows:
        domain = row.get("domain", "unknown")
        link = f"https://park.io/{domain}" if domain else None
        end = row.get("endDate")
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), row.get("bids"), link),
            }
        )
    return bucket_lines(items)


def format_godaddy() -> list[str]:
    path = BASE / "data/godaddy_auctions_filtered.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("matches", [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows:
        domain = row.get("domain", "unknown")
        end = row.get("endTime")
        link = row.get("link") or (f"https://www.godaddy.com/domain-auctions/{domain}" if domain else None)
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), row.get("bidCount"), link),
            }
        )
    return bucket_lines(items)


def format_namesilo() -> list[str]:
    path = BASE / "data/namesilo_auctions_filtered.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("matches", [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows:
        domain = row.get("domain", "unknown")
        link = row.get("link") or (f"https://www.namesilo.com/domain/{domain}" if domain else None)
        end = row.get("endTime")
        bids = row.get("bidCount") or row.get("bids")
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), bids, link),
            }
        )
    return bucket_lines(items)


def format_sedo_expired() -> list[str]:
    path = BASE / "data/sedo_expired_auctions.json"
    data = load_json(path)
    if not isinstance(data, dict):
        return ["• No data found"]

    rows = data.get("matches", [])
    if not rows:
        return ["• No qualifying names found"]

    items = []
    for row in rows:
        domain = row.get("domain", "unknown")
        link = row.get("link") or (f"https://sedo.com/search/details/?domain={domain}" if domain else None)
        end = row.get("endTime")
        bids = row.get("bidCount") or row.get("bids")
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), bids, link),
            }
        )
    return bucket_lines(items)


def format_dynadot() -> list[str]:
    path = BASE / "dynadot_filtered.csv"
    if not path.exists():
        return ["• No CSV found"]

    rows = []
    try:
        with path.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if any((v or "").strip() for v in row.values()):
                    rows.append(row)
    except Exception:
        return ["• Failed to read CSV"]

    if not rows:
        return ["• No qualifying names found"]

    # Show first few rows with best-effort field matching
    rows.sort(
    key=lambda r: (
        -int(r.get("bids", 0) or 0),
        r.get("end_time") or ""
    )
)
    items = []
    for row in rows:
        domain = (
            row.get("domain")
            or row.get("Domain")
            or row.get("name")
            or row.get("Name")
            or "unknown"
        )
        end = (
            row.get("end_time")
            or row.get("endDate")
            or row.get("EndDate")
            or row.get("close_time")
            or row.get("Close")
            or ""
        )
        price = (
            row.get("price")
            or row.get("Price")
            or row.get("min_bid")
            or row.get("Min Bid")
            or ""
        )
        bids = (
            row.get("bids")
            or row.get("Bids")
            or row.get("bidCount")
            or row.get("Bid Count")
            or ""
        )
        link = row.get("url") or row.get("URL") or (f"https://www.dynadot.com/domain/{domain}" if domain else None)
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(price),
                "line": render_row(domain, end, price, bids, link),
            }
        )
    return bucket_lines(items)

def format_namejet() -> list[str]:
    json_path = BASE / "data/namejet_lastchance_full.json"
    data = load_json(json_path)
    if isinstance(data, list) and data:
        rows = sorted(data, key=lambda r: r.get("closing_dt_utc") or "")
        items = []
        for row in rows:
            domain = row.get('domain', 'unknown')
            slug = domain.lower() if isinstance(domain, str) else domain
            link = f"https://www.namejet.com/domain/{slug}.action" if slug else None
            end = row.get("closing_dt_utc") or row.get("closing_text")
            items.append(
                {
                    "domain": domain,
                    "et_dt": parse_et_datetime(end),
                    "price_value": normalize_price_value(row.get("min_bid")),
                    "line": render_row(domain, end, row.get("min_bid"), row.get("bidders"), link),
                }
            )
        return bucket_lines(items)

    # Fallback to legacy digest parsing if JSON missing/empty
    digest_dir = BASE / "namejet_digests"
    if not digest_dir.exists():
        return ["• No NameJet data available"]

    csvs = sorted(digest_dir.glob("*.csv"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not csvs:
        return ["• No NameJet data available"]

    latest = csvs[0]
    rows = []

    try:
        with latest.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                if any((v or "").strip() for v in row.values()):
                    rows.append(row)
    except Exception:
        return [f"• Failed to read digest file: {latest.name}"]

    if not rows:
        return ["• No rows found in digest"]

    parsed = []
    for row in rows:
        domain = (
            row.get("domain")
            or row.get("Domain")
            or row.get("Domain Name")
            or row.get("Name")
            or ""
        )
        close = (
            row.get("end_time")
            or row.get("End Time")
            or row.get("Close Time")
            or row.get("EndDate")
            or row.get("Auction Ends")
            or ""
        )
        price = (
            row.get("price")
            or row.get("Price")
            or row.get("Minimum Bid")
            or row.get("Min Bid")
            or row.get("Current Bid")
            or ""
        )
        bids = (
            row.get("bids")
            or row.get("Bids")
            or row.get("Bid Count")
            or row.get("Bidder Count")
            or "0"
        )

        if not domain:
            continue

        if not allow_domain(domain):
            continue

        parsed.append(
            {
                "domain": domain,
                "end_time": close,
                "price": price,
                "bids": bids,
            }
        )

    if not parsed:
        return [f"• No parseable rows found in {latest.name}"]

    parsed.sort(
        key=lambda r: (
            -int(str(r.get("bids", 0) or 0).replace(",", "") or 0),
            r.get("end_time") or "",
        )
    )

    items = []
    for row in parsed:
        domain = row.get('domain', 'unknown')
        slug = domain.lower() if isinstance(domain, str) else domain
        link = f"https://www.namejet.com/domain/{slug}.action" if slug else None
        end = row.get("end_time")
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("price")),
                "line": render_row(domain, end, row.get("price"), row.get("bids"), link),
            }
        )

    return bucket_lines(items)

def format_namejet_email() -> list[str]:
    path = BASE / "data/namejet_email_filtered.json"
    data = load_json(path)
    if not isinstance(data, list):
        return ["• No NameJet email data available"]
    if not data:
        return ["• No qualifying names found"]

    items = []
    for row in data:
        domain = row.get('domain', 'unknown')
        link = row.get('link') or (f"https://www.namejet.com/domain/{domain}.action" if domain else None)
        end = row.get('closing_dt_utc') or row.get('close_et')
        items.append(
            {
                "domain": domain,
                "et_dt": parse_et_datetime(end),
                "price_value": normalize_price_value(row.get("min_bid") or row.get("min_bid_value")),
                "line": render_row(domain, end, row.get("min_bid") or row.get("min_bid_value"), row.get("bidders"), link),
            }
        )
    return bucket_lines(items)


def load_efty_latest_rows() -> dict[str, dict]:
    if not EFTY_LATEST_CSV_PATH.exists():
        return {}
    rows: dict[str, dict] = {}
    try:
        with EFTY_LATEST_CSV_PATH.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            for row in reader:
                domain = (row.get("domain_name") or "").strip().lower()
                if domain:
                    rows[domain] = row
    except Exception:
        return {}
    return rows


def format_efty_diff() -> list[str]:
    diff = load_json(EFTY_DIFF_PATH)
    if not isinstance(diff, dict):
        return ["• No Efty diff found"]

    latest_rows = load_efty_latest_rows()
    qualified_lines: list[str] = []

    for domain in diff.get("new_domains", []):
        if not allow_domain(domain):
            continue
        row = latest_rows.get(domain, {})
        price = row.get("bin_price") or ""
        link = row.get("landing_page_url") or None
        qualified_lines.append(f"{domain} - new - {format_price(price)} - {format_link(link)}")

    for item in diff.get("price_changes", []):
        domain = str(item.get("domain") or "").strip().lower()
        if not domain or not allow_domain(domain):
            continue
        row = latest_rows.get(domain, {})
        link = row.get("landing_page_url") or None
        old_price = format_price(item.get("from"))
        new_price = format_price(item.get("to"))
        qualified_lines.append(f"{domain} - price change {old_price} → {new_price} - {format_link(link)}")

    if not qualified_lines:
        return ["• No qualifying names in the latest Efty diff"]

    return qualified_lines[:25]


def build_message() -> str:
    refresh_status = load_refresh_status()
    parts = ["🕕 Auction watchlist refresh", ""]

    failed_sources = get_failed_sources(refresh_status)
    if failed_sources:
        parts.append(f":warning: Partial refresh, posted remaining sources anyway. Failed: {', '.join(failed_sources)}")
        parts.append("")

    parts.extend(build_section(refresh_status, "*Namecheap*", "namecheap", format_namecheap))
    parts.extend(build_section(refresh_status, "*Dynadot*", "dynadot", format_dynadot))
    parts.extend(build_section(refresh_status, "*DropCatch*", "dropcatch", format_dropcatch))
    parts.extend(build_section(refresh_status, "*Park.io*", "parkio", format_parkio))
    parts.extend(build_section(refresh_status, "*GoDaddy*", "godaddy", format_godaddy))
    parts.extend(build_section(refresh_status, "*NameSilo*", "namesilo", format_namesilo))
    parts.extend(build_section(refresh_status, "*Sedo Expired*", "sedo_expired", format_sedo_expired))

    while parts and parts[-1] == "":
        parts.pop()

    return "\n".join(parts)


def send_slack(text: str) -> None:
    token = TOKEN_PATH.read_text().strip()
    resp = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={"channel": CHANNEL, "text": text},
        timeout=30,
    )
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Slack error: {data}")


def main() -> None:
    message = build_message()
    send_slack(message)
    print("Posted auction watchlist to Slack.")


if __name__ == "__main__":
    main()
