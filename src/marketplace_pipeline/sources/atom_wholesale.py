"""Atom Wholesale Google Doc ingest.

Port of legacy/openclaw/scripts/process_atom_wholesale_doc.py. Reads the
Atom Wholesale Google Doc (a structured paragraphs feed of: domain →
price → notes → 'View Details' separator), parses each entry, dedups
against the existing rows in the destination tab, and prepends new rows
above existing ones.

This port uses the legacy regex-based parser. The original spec
mentioned LLM-assisted parsing as a future enhancement; can be swapped
in later by replacing parse_entries() while keeping the rest of the
flow intact.

Destination is the standalone Atom Wholesale sheet (not the SNAP main
sheet); identified via products.snap.atom_wholesale_sheet_id in the
registry. Posts to #snap with all new entries (qualified or not, but
qualified ones are marked).
"""
from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .. import config, state
from ..filters import standard as flt
from ..publishers import sheets, slack
from ..publishers.sheets import OwnershipMode

SOURCE_ID = "atom_wholesale"
SOURCE_LABEL = "Atom Wholesale"

DOC_ID = "1-n-fiAOfTf9e5NaVSHCdgyNRTKdPuPBRx2A9XqwzczU"
SHEET_TAB = "Running"

# Atom Wholesale-specific TLD weights; legacy parity (includes .now, .vc, .me)
TLD_WEIGHTS: dict[str, float] = {
    ".com": 1.0, ".ai": 0.9, ".io": 0.7, ".co": 0.7,
    ".org": 0.6, ".net": 0.55, ".now": 0.45, ".me": 0.4, ".vc": 0.35,
}
MIN_ZIPF = 2.8

# 14 cols matching legacy row_for_sheet()
SHEET_HEADER = [
    "domain", "sld", "tld", "zipf_score", "brandability", "deal_score",
    "price", "currency", "source", "date_added", "page", "row_on_page",
    "notes", "raw_text",
]

SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
SNAPSHOT_FILE = "snapshot.json"

DOCS_SCOPES = ["https://www.googleapis.com/auth/documents.readonly"]


# ---------- dataclass ----------

@dataclass
class Entry:
    domain: str
    price_value: float
    price_text: str
    notes: str
    page: int
    row_on_page: int
    raw_text: str

    @property
    def sld(self) -> str:
        return self.domain.split(".", 1)[0]

    @property
    def tld(self) -> str:
        return "." + self.domain.split(".", 1)[1].lower()


# ---------- Google Docs client ----------

def _docs_service():
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE must be set"
        )
    creds = Credentials.from_service_account_info(json.loads(raw), scopes=DOCS_SCOPES)
    return build("docs", "v1", credentials=creds, cache_discovery=False)


def read_doc_paragraphs(doc_id: str, service: Any = None) -> list[str]:
    """Return every non-empty paragraph from the doc body."""
    svc = service or _docs_service()
    doc = svc.documents().get(documentId=doc_id).execute()
    out: list[str] = []
    for block in doc.get("body", {}).get("content", []):
        para = block.get("paragraph")
        if not para:
            continue
        parts: list[str] = []
        for el in para.get("elements", []):
            tr = el.get("textRun")
            if tr:
                parts.append(tr.get("content", ""))
        text = "".join(parts).strip()
        if text:
            out.append(text)
    return out


# ---------- pure parsing / scoring ----------

PRICE_RX = re.compile(r"\$\s*([0-9,]+(?:\.[0-9]{2})?)")


def parse_price(text: str) -> tuple[float, str] | None:
    """Find a price in a paragraph: returns (numeric, formatted)."""
    m = PRICE_RX.search(text)
    if not m:
        return None
    raw = m.group(1)
    return float(raw.replace(",", "")), f"${raw}"


def parse_entries(paragraphs: list[str]) -> list[Entry]:
    """Walk the doc's paragraph stream, picking out (domain, price, notes, 'View Details')."""
    entries: list[Entry] = []
    i = 0
    row_on_page = 0
    page = 1
    while i < len(paragraphs):
        domain = paragraphs[i].strip()
        if "." not in domain or " " in domain:
            i += 1
            continue
        price_info = parse_price(paragraphs[i + 1]) if i + 1 < len(paragraphs) else None
        if not price_info:
            i += 1
            continue
        price_value, price_text = price_info
        notes: list[str] = []
        j = i + 2
        while j < len(paragraphs) and paragraphs[j] != "View Details":
            notes.append(paragraphs[j])
            j += 1
        if j >= len(paragraphs):
            # Reached end without finding 'View Details' — skip this entry
            i += 1
            continue
        row_on_page += 1
        raw_text = (
            " | ".join([domain, *notes, price_text, "View Details"])
            if notes else f"{domain} | {price_text} | View Details"
        )
        entries.append(Entry(
            domain=domain.lower(),
            price_value=price_value,
            price_text=price_text,
            notes=" | ".join(notes),
            page=page,
            row_on_page=row_on_page,
            raw_text=raw_text,
        ))
        i = j + 1
    return entries


def _tld_weight(tld: str) -> float:
    return TLD_WEIGHTS.get(tld, 0.2)


def brandability(zipf: float, length: int, tld_weight: float) -> float:
    length_bonus = max(0.0, 16 - length) * 2.2
    zipf_component = min(50.0, zipf * 12.5)
    tld_component = tld_weight * 28.0
    return round(zipf_component + length_bonus + tld_component, 1)


def deal_score(zipf: float, price: float, tld_weight: float) -> float:
    weight = max(tld_weight, 0.1)
    if price <= 0:
        return 0.0
    return round((zipf * weight) / max(price, 1.0) * 10000.0, 1)


def row_for_sheet(entry: Entry, today: str) -> dict[str, Any]:
    sld = entry.sld
    tld = entry.tld
    zipf = round(flt.freq(sld), 1) if sld.isalpha() else 0.0
    weight = _tld_weight(tld)
    return {
        "domain": entry.domain,
        "sld": sld.capitalize(),
        "tld": tld.lstrip("."),
        "zipf_score": zipf,
        "brandability": brandability(zipf, len(sld), weight),
        "deal_score": deal_score(zipf, entry.price_value, weight),
        "price": f"${entry.price_value:,.2f}",
        "currency": "USD",
        "source": SOURCE_LABEL,
        "date_added": today,
        "page": str(entry.page),
        "row_on_page": str(entry.row_on_page),
        "notes": entry.notes,
        "raw_text": entry.raw_text,
    }


def is_qualified(entry: Entry) -> bool:
    """Does this entry meet the daily SNAP filter on top of being parsed?"""
    sld = entry.sld
    if not sld.isalpha():
        return False
    zipf = flt.freq(sld)
    if zipf < MIN_ZIPF:
        return False
    if not flt.is_clean_word(sld, MIN_ZIPF):
        return False
    if _tld_weight(entry.tld) <= 0.2:  # default weight; flag as non-strict
        return False
    return True


def build_slack_message(*, entries: list[Entry], appended: int, sheet_url: str) -> str:
    """Slack message body for the new entries (qualified or not, marked)."""
    lines: list[str] = []
    for e in entries:
        sld = e.sld
        zipf = flt.freq(sld) if sld.isalpha() else None
        weight = _tld_weight(e.tld)
        qualified = is_qualified(e)
        deal = deal_score(zipf or 0.0, e.price_value, weight) if qualified else None
        link = f"https://www.atom.com/ws/name/{sld.capitalize()}{e.tld}"
        metrics: list[str] = []
        if zipf is not None:
            metrics.append(f"zipf {zipf:.1f}")
        if deal is not None:
            metrics.append(f"deal {deal:.1f}")
        if qualified:
            metrics.append("SNAP")
        metric_text = f" — {' — '.join(metrics)}" if metrics else ""
        lines.append(
            f"• {e.domain} — ${e.price_value:,.0f}{metric_text} — <{link}|link>"
        )
    body = (
        f"Atom Wholesale refresh, {appended} new rows appended to Running. "
        f"All new rows:\n" + "\n".join(lines) + f"\n\nFull sheet: <{sheet_url}|sheet>"
    )
    return body


# ---------- main entrypoint ----------

def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    snap_cfg = reg["products"]["snap"]
    sheet_id = snap_cfg["atom_wholesale_sheet_id"]
    slack_channel = os.environ.get(snap_cfg["slack_channel_env"], "C09B1P21YQ0")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    today = datetime.now(timezone.utc).date().isoformat()

    print(f"[1/5] Reading Google Doc {DOC_ID}")
    paragraphs = read_doc_paragraphs(DOC_ID)
    print(f"      paragraphs: {len(paragraphs):,}")

    print("[2/5] Parsing entries")
    parsed = parse_entries(paragraphs)
    print(f"      parsed entries: {len(parsed):,}")

    print(f"[3/5] Writing '{SHEET_TAB}' (PREPEND_NEW_ROWS — dedup by domain)")
    rows = [row_for_sheet(e, today) for e in parsed]
    sheet_stats = sheets.write_rows(
        spreadsheet_id=sheet_id,
        tab=SHEET_TAB,
        mode=OwnershipMode.PREPEND_NEW_ROWS,
        source=SOURCE_LABEL,
        rows=rows,
        default_header=SHEET_HEADER,
    )
    print(f"      stats: {sheet_stats}")

    # Build the list of new entries actually added (matched by domain to stats)
    # Easiest: the impl skipped by key existence; we reconstruct by checking
    # current sheet keys... but that requires another read. For simplicity,
    # use parsed entries and let the Slack message reflect all parsed; the
    # legacy posted all rows from parsed (not just newly added), so this
    # matches behavior. The `appended` count in the Slack message uses
    # sheet_stats["added"] for accuracy.
    print("[4/5] Saving snapshot")
    state.write_json(SOURCE_ID, SNAPSHOT_FILE, [
        {
            "domain": e.domain,
            "price": e.price_value,
            "notes": e.notes,
            "page": e.page,
            "row_on_page": e.row_on_page,
        }
        for e in parsed
    ])

    print(f"[5/5] Posting to Slack channel {slack_channel}")
    posted = False
    if parsed:
        message = build_slack_message(
            entries=parsed,
            appended=sheet_stats["added"],
            sheet_url=sheet_url,
        )
        posted = slack.post(
            channel=slack_channel,
            text=message,
            dedupe_key=slack.make_fingerprint(message),
            source=SOURCE_ID,
        )
        print(f"      slack posted: {posted}")
    else:
        print("      no entries parsed — skipping Slack")

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "paragraphs_scanned": len(paragraphs),
        "entries_parsed": len(parsed),
        "new_count": sheet_stats["added"],
        "skipped_existing": sheet_stats["skipped"],
        "sheet_total_after": sheet_stats["total_after"],
        "slack_posted": posted,
    })

    print("DONE")
    return 0
