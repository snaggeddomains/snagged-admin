#!/usr/bin/env python3
"""Scan exact accelerator upgrade targets against full Afternic + Atom + Supabase inventories."""
from __future__ import annotations

import csv
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Set, Tuple
from urllib.parse import urljoin, urlparse
from zoneinfo import ZoneInfo

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parent.parent
SHEET_ID = "1Rq_l8nNQ_zn26mrM6PgJ6dXS3h17R-PIeY3BCNF8OKE"
FRESH_TAB = "Fresh Upgrade Overlap"
RUNNING_TAB = "Upgrade Overlap Running"
TARGET_MAP_FILE = BASE_DIR / "data" / "accelerator_upgrade_targets.json"
AFTERNIC_FULL_FILE = BASE_DIR / "data" / "afternic" / "inventory_latest.csv"
ATOM_DIR = BASE_DIR / "data"
SUPABASE_FILE = BASE_DIR / "data" / "supabase_master_domain_list.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
SERVICE_ACCOUNT_CANDIDATES = [
    BASE_DIR / ".secrets" / "google_service_account.json",
    Path("/root/.secrets/google_service_account.json"),
    Path("/root/.secrets/google-gmail.json"),
]
TOKEN_PATH = BASE_DIR / ".secrets" / "slack-bot-token.txt"
CONFIG_PATH = BASE_DIR / "data" / "upgrade_overlap_config.json"
DEFAULT_SLACK_CHANNEL = "D0ALF938RCK"  # Stimpy DM with Rob
LANDER_CACHE_PATH = BASE_DIR / "data" / "upgrade_lander_cache.json"
FUNDRAISE_CACHE_PATH = BASE_DIR / "data" / "upgrade_fundraise_cache.json"
TZ_ET = ZoneInfo("America/New_York")
SHEET_HEADERS = [
    "date_added",
    "startup_name",
    "current_domain",
    "proposed_upgrade",
    "tld",
    "platform",
    "price",
    "link",
    "notes",
    "accelerator",
    "cohort",
    "industry_category",
    "all_locations",
    "last_fundraise_amount",
    "last_fundraise_date",
]
BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"
FUNDRAISE_CACHE_VERSION = 3
BRAVE_KEY_PATH_CANDIDATES = [
    BASE_DIR / "secrets" / "brave_api_key.txt",
    BASE_DIR / ".secrets" / "brave_api_key",
    BASE_DIR / ".secrets" / "brave_api_key.txt",
]
FUNDRAISE_KEYWORDS = [
    "funding",
    "raised",
    "raises",
    "raise",
    "valuation",
    "valued",
    "post-money",
    "pre-money",
    "series ",
    "seed",
    "pre-seed",
    "round",
]
FUNDRAISE_SOURCE_HOSTS = [
    "techcrunch.com",
    "crunchbase.com",
    "pitchbook.com",
    "tracxn.com",
    "dealroom.co",
    "axios.com",
    "venturebeat.com",
    "forbes.com",
]
ROUND_RE = re.compile(r"\b(pre[- ]seed|seed|series\s+[a-z]|series\s+[ivx]+|angel|venture\s+round|private\s+equity|debt\s+financing|convertible\s+note)\b", re.IGNORECASE)
MONEY_RE = re.compile(r"\$\s?\d+(?:\.\d+)?\s?(?:[mbk]|million|billion|thousand)?", re.IGNORECASE)
VALUATION_RE = re.compile(r"(?:valu(?:ed|ation)|post-money valuation|pre-money valuation)[^$]{0,40}(\$\s?\d+(?:\.\d+)?\s?(?:[mbk]|million|billion|thousand)?)", re.IGNORECASE)
LANDER_CACHE_VERSION = 5
LANDER_HOST_MARKERS = [
    "forsale.godaddy.com",
    "afternic.com",
    "atom.com",
    "dan.com",
    "sedo.com",
    "hugedomains.com",
    "brandbucket.com",
    "venture.com",
    "hilcodigital.com",
    "oxley.com",
    "uniregistrymarket.link",
]
LANDER_TEXT_MARKERS = [
    "this domain is for sale",
    "buy this domain",
    "purchase this domain",
    "make an offer",
    "own this domain",
    "broker this domain",
    "digimedia.com",
]


class InventoryEntry:
    __slots__ = ("domain", "price", "platform", "link")

    def __init__(self, domain: str, price: float | None, platform: str, link: str | None = None) -> None:
        self.domain = domain
        self.price = price
        self.platform = platform
        self.link = link or ""


def resolve_service_account_path() -> Path:
    for path in SERVICE_ACCOUNT_CANDIDATES:
        if path.exists():
            return path
    checked = ", ".join(str(path) for path in SERVICE_ACCOUNT_CANDIDATES)
    raise FileNotFoundError(f"Missing Google service-account credentials. Checked: {checked}")


def build_sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        str(resolve_service_account_path()), scopes=SCOPES
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def load_sheet(service, tab: str, rng: str) -> List[List[str]]:
    result = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range=f"{tab}!{rng}")
        .execute()
    )
    return result.get("values", [])


def load_json(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError:
        return None


def load_lander_cache() -> dict:
    payload = load_json(LANDER_CACHE_PATH)
    return payload if isinstance(payload, dict) else {}


def save_lander_cache(cache: dict) -> None:
    LANDER_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    LANDER_CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))


def load_fundraise_cache() -> dict:
    payload = load_json(FUNDRAISE_CACHE_PATH)
    return payload if isinstance(payload, dict) else {}


def save_fundraise_cache(cache: dict) -> None:
    FUNDRAISE_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    FUNDRAISE_CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True))


def latest_atom_file() -> Path | None:
    candidates = sorted(
        f
        for f in ATOM_DIR.glob("atom_partner_*.csv")
        if f.name.startswith("atom_partner_") and f.suffix == ".csv"
    )
    return candidates[-1] if candidates else None


def load_target_map() -> List[dict]:
    payload = load_json(TARGET_MAP_FILE)
    if not isinstance(payload, dict):
        return []
    rows = payload.get("records", [])
    return rows if isinstance(rows, list) else []


def build_target_index(rows: Iterable[dict]) -> Dict[str, List[dict]]:
    index: Dict[str, List[dict]] = {}
    for row in rows:
        startup = (row.get("startup_name") or "").strip()
        current_domain = (row.get("current_domain") or "").strip().lower()
        if not startup or not current_domain:
            continue
        for target in row.get("targets", []) or []:
            domain = str(target).strip().lower()
            if not domain or domain == current_domain or "." not in domain or "-" in domain:
                continue
            index.setdefault(domain, []).append(
                {
                    "startup_name": startup,
                    "current_domain": current_domain,
                    "accelerator": (row.get("accelerator") or "").strip(),
                    "cohort": (row.get("cohort") or "").strip(),
                    "industry_category": (row.get("industry_category") or "").strip(),
                    "all_locations": (row.get("all_locations") or "").strip(),
                }
            )
    return index


def format_price(value: float | None) -> str:
    if value is None:
        return "—"
    if value >= 1000:
        return f"${value:,.0f}"
    return f"${value:,.0f}" if float(value).is_integer() else f"${value:,.2f}"


def brave_key_path() -> Path | None:
    for path in BRAVE_KEY_PATH_CANDIDATES:
        if path.exists() and path.read_text().strip():
            return path
    return None


def brave_headers() -> dict[str, str] | None:
    key_path = brave_key_path()
    if not key_path:
        return None
    return {
        "Accept": "application/json",
        "X-Subscription-Token": key_path.read_text().strip(),
    }


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def pretty_source(url: str) -> str:
    host = (urlparse(url).netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return host or "public web"


def is_valid_atom_listing(link: str | None) -> bool:
    url = (link or "").strip()
    if not url:
        return False
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    if "atom.com" not in host:
        return False
    return path.startswith("/name/")


def money_list(text: str) -> list[str]:
    return [normalize_space(m) for m in MONEY_RE.findall(text or "")]


def extract_round(text: str) -> str:
    match = ROUND_RE.search(text or "")
    if not match:
        return ""
    return normalize_space(match.group(1)).title().replace("Pre Seed", "Pre-Seed")


def extract_valuation(text: str) -> str:
    match = VALUATION_RE.search(text or "")
    if not match:
        return ""
    amount = normalize_space(match.group(1))
    lowered = (text or "").lower()
    if "post-money" in lowered:
        return f"{amount} post-money valuation"
    if "pre-money" in lowered:
        return f"{amount} pre-money valuation"
    return f"{amount} valuation"


def money_to_number(text: str) -> float | None:
    raw = normalize_space(text).lower().replace("$", "").replace(",", "")
    if not raw:
        return None
    multiplier = 1.0
    if raw.endswith("billion"):
        raw = raw[:-7].strip()
        multiplier = 1_000_000_000
    elif raw.endswith("million"):
        raw = raw[:-7].strip()
        multiplier = 1_000_000
    elif raw.endswith("thousand"):
        raw = raw[:-8].strip()
        multiplier = 1_000
    elif raw.endswith("bn"):
        raw = raw[:-2].strip()
        multiplier = 1_000_000_000
    elif raw.endswith("m"):
        raw = raw[:-1].strip()
        multiplier = 1_000_000
    elif raw.endswith("k"):
        raw = raw[:-1].strip()
        multiplier = 1_000
    try:
        return float(raw) * multiplier
    except ValueError:
        return None


def extract_date_iso(item: dict) -> str:
    page_age = item.get("page_age")
    if isinstance(page_age, str) and page_age:
        try:
            dt = datetime.fromisoformat(page_age.replace("Z", "+00:00"))
            return dt.date().isoformat()
        except ValueError:
            return ""
    return ""


def score_fundraise_result(item: dict, match: dict) -> int:
    startup = (match.get("startup_name") or "").strip()
    current_domain = (match.get("current_domain") or "").strip().lower()
    accelerator = (match.get("accelerator") or "").strip().lower()
    cohort = (match.get("cohort") or "").strip().lower()
    text = normalize_space(f"{item.get('title') or ''} {item.get('description') or ''}").lower()
    url = str(item.get("url") or "").lower()
    root = current_domain.split(".", 1)[0].lower() if current_domain else ""
    score = 0
    corroborated = False
    if startup.lower() in text:
        score += 3
    if current_domain.lower() in text or current_domain.lower() in url:
        score += 5
        corroborated = True
    elif root and root in text:
        score += 1
    if accelerator and accelerator in text:
        score += 3
        corroborated = True
    if cohort and cohort in text:
        score += 2
        corroborated = True
    if any(keyword in text for keyword in FUNDRAISE_KEYWORDS):
        score += 3
    if any(host in url for host in FUNDRAISE_SOURCE_HOSTS):
        score += 2
    if extract_round(text):
        score += 1
    if money_list(text):
        score += 1
    if not corroborated:
        return 0
    return score


def extract_fundraise_fields(item: dict) -> tuple[float | None, str, str]:
    text = normalize_space(f"{item.get('title') or ''}. {item.get('description') or ''}")
    round_name = extract_round(text)
    valuation = extract_valuation(text)
    amounts = money_list(text)
    raised = ""
    if amounts:
        if valuation and amounts[0] in valuation and len(amounts) > 1:
            raised = amounts[1]
        else:
            raised = amounts[0]
    raised_value = money_to_number(raised) if raised else None
    date_iso = extract_date_iso(item) if raised_value is not None else ""
    source = pretty_source(str(item.get("url") or ""))

    summary_bits = []
    if round_name:
        summary_bits.append(round_name)
    if raised:
        summary_bits.append(f"{raised} raised")
    if valuation:
        summary_bits.append(valuation)
    summary = ", ".join(summary_bits)
    if summary and source:
        summary = f"{summary} ({source})"
    return raised_value, date_iso, summary


def brave_search(query: str, count: int = 5) -> list[dict]:
    headers = brave_headers()
    if not headers:
        return []
    resp = requests.get(
        BRAVE_ENDPOINT,
        headers=headers,
        params={
            "q": query,
            "count": count,
            "search_lang": "en",
            "country": "us",
        },
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    results = payload.get("web", {}).get("results", [])
    return results if isinstance(results, list) else []


def fundraise_cache_key(match: dict) -> str:
    startup = (match.get("startup_name") or "").strip().lower()
    current_domain = (match.get("current_domain") or "").strip().lower()
    return f"{startup}|{current_domain}"


def get_last_fundraise_fields(match: dict, cache: dict) -> tuple[float | str, str]:
    key = fundraise_cache_key(match)
    cached = cache.get(key)
    if isinstance(cached, dict) and cached.get("version") == FUNDRAISE_CACHE_VERSION:
        amount = cached.get("amount")
        date_iso = str(cached.get("date") or "")
        return (amount if isinstance(amount, (int, float)) else ""), date_iso

    startup = (match.get("startup_name") or "").strip()
    current_domain = (match.get("current_domain") or "").strip().lower()
    accelerator = (match.get("accelerator") or "").strip()
    if not startup or not current_domain:
        return ""

    queries = [
        f'"{startup}" "{current_domain}" funding valuation raised',
        f'"{startup}" "{accelerator}" "{match.get("cohort") or ""}" funding valuation'.strip(),
    ]
    deduped: dict[str, dict] = {}
    best_item: dict | None = None
    best_score = -1
    for query in queries:
        try:
            results = brave_search(query)
        except Exception:
            continue
        for item in results:
            url = str(item.get("url") or "").strip()
            if not url or url in deduped:
                continue
            deduped[url] = item
            score = score_fundraise_result(item, match)
            if score > best_score:
                best_score = score
                best_item = item

    summary = ""
    amount_value: float | None = None
    date_iso = ""
    if best_item and best_score >= 6:
        amount_value, date_iso, summary = extract_fundraise_fields(best_item)

    cache[key] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "amount": amount_value,
        "date": date_iso,
        "summary": summary,
        "version": FUNDRAISE_CACHE_VERSION,
    }
    return (amount_value if amount_value is not None else ""), date_iso


def load_slack_channel() -> str:
    env_channel = os.getenv("UPGRADE_OVERLAP_SLACK_CHANNEL", "").strip()
    if env_channel:
        return env_channel
    payload = load_json(CONFIG_PATH)
    if isinstance(payload, dict):
        configured = str(payload.get("slack_channel") or payload.get("channel") or "").strip()
        if configured:
            return configured
    return DEFAULT_SLACK_CHANNEL


def send_slack(rows: List[List[str]]) -> None:
    channel = load_slack_channel()
    if not channel or not TOKEN_PATH.exists() or not rows:
        return
    header = f":mag: Upgrade overlap hits — {datetime.now(TZ_ET).strftime('%Y-%m-%d %I:%M %p %Z')}"
    lines = [header, ""]
    for row in rows[:25]:
        startup = row[1] if len(row) > 1 else ""
        current_domain = row[2] if len(row) > 2 else ""
        proposed_upgrade = row[3] if len(row) > 3 else ""
        platform = row[5] if len(row) > 5 else ""
        price = row[6] if len(row) > 6 else ""
        link = row[7] if len(row) > 7 else ""
        upgrade_display = f"<{link}|{proposed_upgrade}>" if link else proposed_upgrade
        lines.append(f"• {startup}: {current_domain} → {upgrade_display} — {platform} — {price}")
    if len(rows) > 25:
        lines.append("")
        lines.append(f"…plus {len(rows) - 25} more")

    token = TOKEN_PATH.read_text().strip()
    resp = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={"channel": channel, "text": "\n".join(lines)},
        timeout=30,
    )
    data = resp.json()
    if not data.get("ok"):
        raise RuntimeError(f"Slack error: {data}")


def load_existing_pairs(rows: Iterable[List[str]]) -> Set[Tuple[str, str]]:
    pairs: Set[Tuple[str, str]] = set()
    for row in rows:
        if len(row) < 4:
            continue
        startup = row[1].strip().lower()
        upgrade = row[3].strip().lower()
        if startup and upgrade:
            pairs.add((startup, upgrade))
    return pairs


def ensure_headers(service) -> None:
    body = {"values": [SHEET_HEADERS]}
    for tab in (FRESH_TAB, RUNNING_TAB):
        service.spreadsheets().values().update(
            spreadsheetId=SHEET_ID,
            range=f"{tab}!A1:O1",
            valueInputOption="RAW",
            body=body,
        ).execute()
    format_fundraise_columns(service)


def format_fundraise_columns(service) -> None:
    meta = service.spreadsheets().get(
        spreadsheetId=SHEET_ID,
        fields="sheets(properties(sheetId,title))",
    ).execute()
    for sheet in meta.get("sheets", []):
        props = sheet.get("properties", {})
        title = props.get("title")
        if title not in {FRESH_TAB, RUNNING_TAB}:
            continue
        sheet_id = props.get("sheetId")
        if sheet_id is None:
            continue
        service.spreadsheets().batchUpdate(
            spreadsheetId=SHEET_ID,
            body={
                "requests": [
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": 1,
                                "startColumnIndex": 13,
                                "endColumnIndex": 14,
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "numberFormat": {"type": "CURRENCY", "pattern": "$#,##0"}
                                }
                            },
                            "fields": "userEnteredFormat.numberFormat",
                        }
                    },
                    {
                        "repeatCell": {
                            "range": {
                                "sheetId": sheet_id,
                                "startRowIndex": 1,
                                "startColumnIndex": 14,
                                "endColumnIndex": 15,
                            },
                            "cell": {
                                "userEnteredFormat": {
                                    "numberFormat": {"type": "DATE", "pattern": "yyyy-mm-dd"}
                                }
                            },
                            "fields": "userEnteredFormat.numberFormat",
                        }
                    },
                ]
            },
        ).execute()


def check_for_sale_lander(domain: str) -> dict:
    headers = {"User-Agent": "Mozilla/5.0 (compatible; OpenClawUpgradeOverlap/1.0)"}
    result = False
    final_url = ""

    for url in (f"https://{domain}", f"http://{domain}"):
        try:
            resp = requests.get(url, headers=headers, allow_redirects=True, timeout=4)
        except requests.RequestException:
            continue

        final_url = resp.url.lower()
        host = (urlparse(resp.url).netloc or "").lower()
        body = (resp.text or "")[:20000].lower()

        js_lander = re.search(r"location\.(?:href|replace)\s*=\s*['\"](/lander[^'\"]*)['\"]", body)
        if js_lander:
            lander_url = urljoin(resp.url, js_lander.group(1))
            try:
                lander_resp = requests.get(lander_url, headers=headers, allow_redirects=True, timeout=4)
                final_url = lander_resp.url.lower()
                host = (urlparse(lander_resp.url).netloc or "").lower()
                lander_body = (lander_resp.text or "")[:20000].lower()
                if any(marker in host for marker in LANDER_HOST_MARKERS) or any(marker in final_url for marker in LANDER_HOST_MARKERS):
                    if any(marker in final_url or marker in lander_body for marker in LANDER_TEXT_MARKERS) or host != domain:
                        result = True
                        break
                body = lander_body
            except requests.RequestException:
                pass

        if any(marker in host for marker in LANDER_HOST_MARKERS) or any(marker in final_url for marker in LANDER_HOST_MARKERS):
            if any(marker in final_url or marker in body for marker in LANDER_TEXT_MARKERS) or host != domain:
                result = True
                break
        if any(marker in body for marker in LANDER_TEXT_MARKERS):
            result = True
            break

        # We got a normal-looking live page, no need to try the fallback scheme.
        break

    return {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "is_for_sale_lander": result,
        "final_url": final_url,
        "version": LANDER_CACHE_VERSION,
    }


def filter_entries_by_lander(entries: List[List[str]], cache: dict) -> List[List[str]]:
    domains = sorted({row[3].strip().lower() for row in entries if len(row) >= 4 and row[3].strip()})
    missing = [
        domain
        for domain in domains
        if not (
            isinstance(cache.get(domain), dict)
            and "is_for_sale_lander" in cache[domain]
            and cache[domain].get("version") == LANDER_CACHE_VERSION
        )
    ]

    if missing:
        with ThreadPoolExecutor(max_workers=16) as pool:
            future_map = {pool.submit(check_for_sale_lander, domain): domain for domain in missing}
            for future in as_completed(future_map):
                domain = future_map[future]
                try:
                    cache[domain] = future.result()
                except Exception:
                    cache[domain] = {
                        "checked_at": datetime.now(timezone.utc).isoformat(),
                        "is_for_sale_lander": False,
                        "final_url": "",
                        "version": LANDER_CACHE_VERSION,
                    }

    kept: List[List[str]] = []
    for row in entries:
        domain = row[3].strip().lower()
        cached = cache.get(domain) if domain else None
        if isinstance(cached, dict) and cached.get("is_for_sale_lander"):
            continue
        kept.append(row)
    return kept


def add_match_rows(
    entry: InventoryEntry,
    target_index: Dict[str, List[dict]],
    existing_pairs: Set[Tuple[str, str]],
    today: str,
    new_entries: List[List[str]],
    fundraise_cache: dict,
) -> None:
    if "-" in entry.domain:
        return
    if "sedo.com" in entry.link.lower() and entry.price is None:
        return
    for match in target_index.get(entry.domain, []):
        startup = (match.get("startup_name") or "").strip()
        current_domain = (match.get("current_domain") or "").strip().lower()
        if not startup or not current_domain:
            continue
        key = (startup.lower(), entry.domain)
        if key in existing_pairs:
            continue
        tld = entry.domain.rsplit(".", 1)[-1]
        new_entries.append(
            [
                today,
                startup,
                current_domain,
                entry.domain,
                tld,
                entry.platform,
                format_price(entry.price),
                entry.link,
                "",
                match.get("accelerator") or "",
                match.get("cohort") or "",
                match.get("industry_category") or "",
                match.get("all_locations") or "",
                *get_last_fundraise_fields(match, fundraise_cache),
            ]
        )
        existing_pairs.add(key)


def scan_afternic_full(
    target_index: Dict[str, List[dict]],
    existing_pairs: Set[Tuple[str, str]],
    today: str,
    new_entries: List[List[str]],
    fundraise_cache: dict,
) -> None:
    if not AFTERNIC_FULL_FILE.exists():
        return
    with AFTERNIC_FULL_FILE.open(encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            domain = str(row.get("domain", "")).strip().lower()
            if domain not in target_index:
                continue
            price_raw = row.get("price")
            try:
                price = float(price_raw) if price_raw not in (None, "", "-") else None
            except (TypeError, ValueError):
                price = None
            entry = InventoryEntry(
                domain=domain,
                price=price,
                platform="Afternic",
                link=f"https://www.afternic.com/domain/{domain}",
            )
            add_match_rows(entry, target_index, existing_pairs, today, new_entries, fundraise_cache)


def scan_atom_full(
    target_index: Dict[str, List[dict]],
    existing_pairs: Set[Tuple[str, str]],
    today: str,
    new_entries: List[List[str]],
    fundraise_cache: dict,
) -> None:
    atom_path = latest_atom_file()
    if not atom_path:
        return
    with atom_path.open(encoding="utf-8", errors="replace", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            domain = str(row.get("title", "")).strip().lower()
            if domain not in target_index:
                continue
            price_raw = row.get("price") or row.get("discount_price")
            try:
                price = float(price_raw) if price_raw not in (None, "", "-") else None
            except (TypeError, ValueError):
                price = None
            link = (row.get("link") or f"https://www.atom.com/name/{domain.split('.', 1)[0]}").strip()
            if not is_valid_atom_listing(link):
                continue
            entry = InventoryEntry(
                domain=domain,
                price=price,
                platform="Atom",
                link=link,
            )
            add_match_rows(entry, target_index, existing_pairs, today, new_entries, fundraise_cache)


def scan_supabase_full(
    target_index: Dict[str, List[dict]],
    existing_pairs: Set[Tuple[str, str]],
    today: str,
    new_entries: List[List[str]],
    fundraise_cache: dict,
) -> None:
    if not SUPABASE_FILE.exists():
        return
    data = json.loads(SUPABASE_FILE.read_text())
    if not isinstance(data, list):
        return
    for row in data:
        domain = str(row.get("domain", "")).strip().lower()
        if domain not in target_index:
            continue
        price_raw = row.get("price")
        try:
            price = float(price_raw) if price_raw not in (None, "", "-", 0, 0.0) else None
        except (TypeError, ValueError):
            price = None
        platform = (row.get("source") or "Supabase").strip().title()
        link = row.get("link") or f"https://snagged-dashboard.vercel.app/domain-search?domain={domain}"
        entry = InventoryEntry(domain=domain, price=price, platform=platform, link=link)
        add_match_rows(entry, target_index, existing_pairs, today, new_entries, fundraise_cache)


def main() -> None:
    service = build_sheets_service()
    ensure_headers(service)

    target_rows = load_target_map()
    if not target_rows:
        print("[ERROR] No target map found. Run scripts/build_upgrade_target_map.py first.")
        return
    target_index = build_target_index(target_rows)
    if not target_index:
        print("[ERROR] Target map is empty.")
        return

    running_rows = load_sheet(service, RUNNING_TAB, "A2:O")
    fresh_rows = load_sheet(service, FRESH_TAB, "A2:O")
    existing_pairs = load_existing_pairs(running_rows + fresh_rows)
    lander_cache = load_lander_cache()
    fundraise_cache = load_fundraise_cache()

    today = datetime.now(TZ_ET).date().isoformat()
    new_entries: List[List[str]] = []

    scan_afternic_full(target_index, existing_pairs, today, new_entries, fundraise_cache)
    scan_atom_full(target_index, existing_pairs, today, new_entries, fundraise_cache)
    scan_supabase_full(target_index, existing_pairs, today, new_entries, fundraise_cache)
    new_entries = filter_entries_by_lander(new_entries, lander_cache)
    save_lander_cache(lander_cache)
    save_fundraise_cache(fundraise_cache)

    if not new_entries:
        print("[INFO] No new overlaps detected.")
        return

    body = {"values": new_entries}
    service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"{FRESH_TAB}!A2",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()
    send_slack(new_entries)
    print(f"[INFO] Added {len(new_entries)} new overlaps to Fresh tab.")


if __name__ == "__main__":
    main()
