#!/usr/bin/env python3
"""Compute the daily Atom diff (net-new vs. previous dump) and update the Today's New Listings sheet."""
from __future__ import annotations

import csv
import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Dict, Iterable, List, Set, Tuple

import requests
from google.oauth2 import service_account
from googleapiclient.discovery import build
from wordfreq import zipf_frequency

from domain_filters import ALLOWED_TLDS, allow_domain, normalize_tld

BASE_DIR = Path(__file__).resolve().parent.parent
ATOM_DIR = BASE_DIR / "data"
DIFF_JSON = BASE_DIR / "data" / "atom_diff.json"
SHEET_ID = "1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8"  # Today's New Listings / Running Good Deals sheet
SHEET_TAB = "Today's New Listings"
RUNNING_TAB = "Running Good Deals"
SERVICE_ACCOUNT = BASE_DIR / ".secrets" / "google_service_account.json"
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
PYTHON = BASE_DIR / ".venv" / "bin" / "python"
TARGET_MAP_BUILDER = BASE_DIR / "scripts" / "build_upgrade_target_map.py"
UPGRADE_OVERLAP = BASE_DIR / "scripts" / "run_upgrade_overlap.py"
SLACK_TOKEN_PATH = BASE_DIR / ".secrets" / "slack-bot-token.txt"
SLACK_CHANNEL = "C09B1P21YQ0"  # #snap
SHEET_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit"

TLD_WEIGHTS = {
    ".com": 1.0,
    ".ai": 0.9,
    ".io": 0.7,
    ".net": 0.7,
    ".co": 0.7,
    ".org": 0.6,
    ".computer": 0.3,
}
DEFAULT_WEIGHT = 0.0
MIN_PRICE = 1.0
MIN_LIST_PRICE = 99.0


@dataclass
class AtomEntry:
    domain: str
    price: float
    freq: float
    tld: str
    weight: float
    quality: float
    deal: float
    link: str

    @classmethod
    def from_row(cls, row: dict) -> "AtomEntry | None":
        domain = (row.get("title") or "").strip().lower()
        if not domain or not allow_domain(domain, ALLOWED_TLDS):
            return None
        price_raw = row.get("price") or row.get("discount_price") or ""
        try:
            price = float(price_raw)
        except (TypeError, ValueError):
            return None
        if price <= 0:
            price = MIN_PRICE
        if price < MIN_LIST_PRICE:
            return None
        sld, tld = domain.split(".", 1)
        tld = normalize_tld(tld)
        weight = TLD_WEIGHTS.get(tld, DEFAULT_WEIGHT)
        if weight <= 0:
            return None
        freq = zipf_frequency(sld, "en") if sld else 0.0
        if freq <= 0:
            return None
        quality = freq * weight
        deal = (freq / max(price, MIN_PRICE)) * weight
        return cls(
            domain=domain,
            price=price,
            freq=freq,
            tld=tld,
            weight=weight,
            quality=quality,
            deal=deal,
            link=(row.get("link") or f"https://www.atom.com/name/{sld}").strip(),
        )


def build_sheets_service():
    creds = service_account.Credentials.from_service_account_file(
        str(SERVICE_ACCOUNT), scopes=SCOPES
    )
    return build("sheets", "v4", credentials=creds, cache_discovery=False)


def latest_atom_files() -> Tuple[Path, Path | None]:
    files = sorted(
        f
        for f in ATOM_DIR.glob("atom_partner_*.csv")
        if re.match(r"atom_partner_\d{8}\.csv", f.name)
    )
    if not files:
        raise RuntimeError("No atom_partner_*.csv files found")
    current = files[-1]
    previous = files[-2] if len(files) >= 2 else None
    return current, previous


def count_csv_rows(path: Path) -> int:
    with path.open(newline="", encoding="utf-8") as fh:
        return sum(1 for _ in csv.DictReader(fh))


def load_entries(path: Path) -> Dict[str, AtomEntry]:
    entries: Dict[str, AtomEntry] = {}
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            entry = AtomEntry.from_row(row)
            if entry:
                entries[entry.domain] = entry
    return entries


def date_from_filename(path: Path) -> str:
    match = re.search(r"(\d{8})", path.name)
    if not match:
        return datetime.now(UTC).date().isoformat()
    dt = datetime.strptime(match.group(1), "%Y%m%d").date()
    return dt.isoformat()


def sheet_rows(service, tab: str, cols: str) -> List[List[str]]:
    resp = (
        service.spreadsheets()
        .values()
        .get(spreadsheetId=SHEET_ID, range=f"'{tab}'!{cols}")
        .execute()
    )
    return resp.get("values", [])


def build_sheet_rows(entries: Iterable[AtomEntry], report_date: str, prev_date: str | None) -> List[List[str]]:
    rows: List[List[str]] = []
    prev_val = prev_date or ""
    for entry in entries:
        price_str = f"{entry.price:,.0f}" if entry.price >= 1000 else f"{entry.price:.0f}"
        rows.append(
            [
                entry.domain,
                price_str,
                entry.tld.lstrip("."),
                "Atom",
                f"{entry.freq:.2f}",
                f"{entry.quality:.3f}",
                f"{entry.deal:.5f}",
                entry.link,
                report_date,
                prev_val,
            ]
        )
    return rows


def build_running_rows(entries: Iterable[AtomEntry], report_date: str) -> List[List[object]]:
    rows: List[List[object]] = []
    for entry in entries:
        rows.append(
            [
                entry.domain,
                round(entry.price, 2),
                entry.tld.lstrip("."),
                round(entry.freq, 2),
                "NO",
                round(entry.quality, 3),
                round(entry.deal, 5),
                entry.link,
                report_date,
            ]
        )
    return rows


def replace_fresh_source_rows(service, source_label: str, report_date: str, new_rows: List[List[str]]) -> int:
    existing = sheet_rows(service, SHEET_TAB, "A:J")
    header = existing[0] if existing else [
        "domain",
        "price",
        "tld",
        "source",
        "zipf_score",
        "quality_score",
        "deal_score",
        "link",
        "date_added",
        "prev_snapshot",
    ]

    kept_rows: List[List[str]] = []
    today_keys: Set[Tuple[str, str]] = set()
    source_label_lc = source_label.lower()

    for row in existing[1:]:
        if not row:
            continue
        padded = row + [""] * (10 - len(row))
        domain = padded[0].strip().lower()
        if not domain:
            continue
        source = padded[3].strip().lower()
        date_added = padded[8].strip()
        if source == source_label_lc:
            if domain and date_added == report_date:
                today_keys.add((domain, date_added))
                kept_rows.append(padded[:10])
            continue
        kept_rows.append(padded[:10])

    deduped_new = [row for row in new_rows if (row[0].strip().lower(), row[8].strip()) not in today_keys]
    final_rows = [header] + deduped_new + kept_rows

    service.spreadsheets().values().clear(
        spreadsheetId=SHEET_ID,
        range=f"'{SHEET_TAB}'!A:J",
    ).execute()
    service.spreadsheets().values().update(
        spreadsheetId=SHEET_ID,
        range=f"'{SHEET_TAB}'!A1",
        valueInputOption="USER_ENTERED",
        body={"values": final_rows},
    ).execute()
    return len(deduped_new)


def append_running_rows(service, rows: List[List[object]]) -> int:
    if not rows:
        return 0
    existing = sheet_rows(service, RUNNING_TAB, "A:I")
    existing_domains = {
        row[0].strip().lower()
        for row in existing[1:]
        if row and row[0].strip()
    }
    new_rows = [row for row in rows if row[0].strip().lower() not in existing_domains]
    if not new_rows:
        return 0
    body = {"values": new_rows}
    service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"'{RUNNING_TAB}'!A2",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()
    return len(new_rows)


def append_rows(service, rows: List[List[str]]):
    if not rows:
        return
    body = {"values": rows}
    service.spreadsheets().values().append(
        spreadsheetId=SHEET_ID,
        range=f"{SHEET_TAB}!A2",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body=body,
    ).execute()


def send_slack_update(entries: List[AtomEntry], report_date: str, prev_date: str | None) -> None:
    if not entries or not SLACK_TOKEN_PATH.exists():
        return
    token = SLACK_TOKEN_PATH.read_text().strip()
    lines = []
    for entry in entries[:10]:
        price = f"${entry.price:,.0f}" if entry.price >= 1000 else f"${entry.price:.0f}"
        lines.append(f"• {entry.domain} — {price} — quality {entry.quality:.2f}")
    prev_txt = f" vs {prev_date}" if prev_date else ""
    text = f"Atom diff for {report_date}{prev_txt} is live. Top new names:\n" + "\n".join(lines)
    text += f"\n\nFull sheet: {SHEET_URL}"
    resp = requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        json={"channel": SLACK_CHANNEL, "text": text},
        timeout=30,
    )
    data = resp.json()
    if not data.get("ok"):
        print(f"Slack error: {data}")


def run_upgrade_overlap_pipeline() -> None:
    try:
        python_bin = str(PYTHON) if PYTHON.exists() else (shutil.which("python3") or shutil.which("python") or "python3")
        subprocess.run([python_bin, str(TARGET_MAP_BUILDER)], cwd=str(BASE_DIR), check=True)
        subprocess.run([python_bin, str(UPGRADE_OVERLAP)], cwd=str(BASE_DIR), check=True)
    except Exception as exc:
        print(f"[WARN] Upgrade overlap pipeline failed after Atom diff: {exc}")


def main() -> None:
    current_path, previous_path = latest_atom_files()
    current_total_rows = count_csv_rows(current_path)
    previous_total_rows = count_csv_rows(previous_path) if previous_path else 0
    current_entries = load_entries(current_path)
    previous_entries = load_entries(previous_path) if previous_path else {}

    new_domains = sorted(set(current_entries) - set(previous_entries))
    dropped_domains = sorted(set(previous_entries) - set(current_entries))
    new_entries = sorted(
        (current_entries[d] for d in new_domains),
        key=lambda e: (e.quality, e.deal),
        reverse=True,
    )

    price_changes = []
    for domain in set(current_entries) & set(previous_entries):
        old_price = previous_entries[domain].price
        new_price = current_entries[domain].price
        if round(old_price, 2) != round(new_price, 2):
            price_changes.append(
                {
                    "domain": domain,
                    "old_price": old_price,
                    "new_price": new_price,
                }
            )

    diff_payload = {
        "current_file": current_path.name,
        "previous_file": previous_path.name if previous_path else None,
        "current_total_rows": current_total_rows,
        "previous_total_rows": previous_total_rows,
        "current_filtered_rows": len(current_entries),
        "previous_filtered_rows": len(previous_entries),
        "new_domains": [current_entries[d].__dict__ for d in new_domains],
        "dropped_domains": [previous_entries[d].__dict__ for d in dropped_domains],
        "price_changes": price_changes,
    }
    DIFF_JSON.write_text(json.dumps(diff_payload, indent=2))

    report_date = date_from_filename(current_path)
    prev_date = date_from_filename(previous_path) if previous_path else None

    service = build_sheets_service()
    new_rows = build_sheet_rows(new_entries, report_date, prev_date)
    fresh_added = replace_fresh_source_rows(service, "Atom", report_date, new_rows)
    append_running_rows(service, build_running_rows(new_entries, report_date))
    if fresh_added > 0:
        send_slack_update(new_entries, report_date, prev_date)
    run_upgrade_overlap_pipeline()

    print(
        json.dumps(
            {
                "report_date": report_date,
                "new_added": fresh_added,
                "removed_found": len(dropped_domains),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
