"""NameJet email digest — ingest the daily NameJet backorder email.

NameJet (noreply@namejet.com) emails a daily list of domains available for
backorder (columns: Domain Name / Price / Date). While a scrape/API path is
still TBD, we ingest that email automatically:

  1. A Gmail filter forwards noreply@namejet.com → a Resend Inbound address.
  2. Resend POSTs the email to /api/inbound/namejet (dashboard), which stashes
     the raw email in the naming-project table `namejet_inbound`.
  3. THIS source (run daily by the auctions orchestrator, and event-driven on
     each inbound email) reads EVERY un-processed stashed email, parses each
     table, unions + dedupes the listings, runs them through the SAME auction
     option-filter as the Drive uploads, and publishes to the auctions sheet +
     #auctions Slack — exactly like every other auction producer — then marks
     every processed stash row. Processing all (not just the latest) is what
     lets a batch of forwarded emails all get cleansed + flagged.

FAIL-SAFE: if nothing is stashed (or the naming creds/libs are missing) this
writes a 'skipped' run_status and returns 0 — it never raises, so it can't turn
the daily orchestrator red.
"""
from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any

from .. import auctions, config, state
from ..auctions import sheet as auctions_sheet
from ..auctions import slack as auctions_slack
# Reuse the exact upload option-filter + parsers used by the Drive ingestion
# path so the NameJet email gets the same treatment as a NameJet CSV drop.
from .drive_auction_uploads import upload_filter, _parse_dt, _parse_money

SOURCE_ID = "namejet_email_digest"
SOURCE_LABEL = "NameJet Email"
PLATFORM = "NameJet"
SNAPSHOT_FILE = "snapshot.json"
SHEET_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/{sheet_id}/edit"
INBOX_TABLE = "namejet_inbound"

_DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$")


class _SkipIngest(Exception):
    """Raised internally when there's nothing to ingest; turned into a clean skip."""


def _naming_client():
    url = os.environ.get("SUPABASE_NAMING_URL")
    key = os.environ.get("SUPABASE_NAMING_SERVICE_KEY")
    if not (url and key):
        raise _SkipIngest("SUPABASE_NAMING_URL / SUPABASE_NAMING_SERVICE_KEY not set")
    try:
        from supabase import create_client
    except ImportError as e:
        raise _SkipIngest(f"supabase lib unavailable: {e}")
    return create_client(url, key)


def _fetch_unprocessed(limit: int = 50) -> list[tuple[str, str]]:
    """Return [(row_id, html_or_text), …] for EVERY un-processed inbound email
    (oldest first), or raise _SkipIngest if there's nothing / it can't be read.

    Multiple NameJet emails can be forwarded to the same inbound address and pile
    up between runs (and the daily run only fires once); processing them all —
    not just the latest — is what gets every forwarded email cleansed + flagged.
    Rows with no body are skipped here but still marked processed by the caller so
    they don't accumulate."""
    client = _naming_client()
    try:
        res = (
            client.table(INBOX_TABLE)
            .select("id, html, text")
            .is_("processed_at", "null")
            .order("received_at", desc=False)
            .limit(limit)
            .execute()
        )
    except Exception as e:
        raise _SkipIngest(f"inbound table read failed: {e}")
    rows = res.data or []
    if not rows:
        raise _SkipIngest("no un-processed inbound email")
    out: list[tuple[str, str]] = []
    for row in rows:
        body = (row.get("html") or row.get("text") or "").strip()
        out.append((row["id"], body))
    return out


def _mark_processed(row_id: str, listings_count: int) -> None:
    try:
        client = _naming_client()
        client.table(INBOX_TABLE).update({
            "processed_at": datetime.now(timezone.utc).isoformat(),
            "listings_count": listings_count,
        }).eq("id", row_id).execute()
    except Exception as e:  # non-fatal — re-processing dedupes on the sheet anyway
        print(f"      WARN could not mark inbound row processed: {e}")


def parse_email_listings(html: str) -> list[dict[str, Any]]:
    """Parse the NameJet email's Domain/Price/Date table into auction listings.
    Robust to header rows and link-wrapped domains; non-domain rows are skipped.
    Option-filtering happens in run()."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(html, "html.parser")
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tr in soup.find_all("tr"):
        # No separator: inline tags some forwarding clients inject into the
        # domain (e.g. Superhuman's "eyezone.<wbr/>com") must not become spaces.
        cells = [c.get_text("", strip=True) for c in tr.find_all(["td", "th"])]
        if len(cells) < 3:
            continue
        domain = re.sub(r"\s+", "", cells[0]).lower()  # strip any stray whitespace
        if not _DOMAIN_RE.match(domain) or domain in seen:
            continue  # header / spacer / dupe
        seen.add(domain)
        out.append({
            "domain": domain,
            "price": _parse_money(cells[1]),
            # Email lists times in US Eastern (_parse_dt treats them as such).
            "end_time_utc": _parse_dt(cells[2]),
            "platform": PLATFORM,
            "link": f"https://www.namejet.com/domain/{domain}.action",
        })
    return out


def _skip(detail: str) -> int:
    print(f"      SKIP: {detail}")
    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "skipped",
        "detail": detail,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "new_count": 0,
    })
    print("DONE (skipped)")
    return 0


def run() -> int:
    reg = config.load_registry()
    config.get_source(SOURCE_ID)
    auc_cfg = reg["products"]["auctions"]
    sheet_id = auc_cfg["sheet_id"]
    slack_channel = os.environ.get(auc_cfg["slack_channel_env"], "C096AT8BECS")
    sheet_url = SHEET_URL_TEMPLATE.format(sheet_id=sheet_id)
    now = datetime.now(timezone.utc)

    print("[1/5] Reading ALL un-processed stashed NameJet emails (Resend Inbound → namejet_inbound)")
    try:
        stashed = _fetch_unprocessed()
    except _SkipIngest as e:
        return _skip(str(e))
    print(f"      un-processed emails: {len(stashed)}")

    print("[2/5] Parsing email tables (union + dedupe across all emails)")
    parsed: list[dict[str, Any]] = []
    seen: set[str] = set()
    per_email_count: dict[str, int] = {}
    for row_id, body in stashed:
        rows_i = parse_email_listings(body) if body else []
        kept = 0
        for L in rows_i:
            if L["domain"] in seen:
                continue
            seen.add(L["domain"])
            parsed.append(L)
            kept += 1
        per_email_count[row_id] = len(rows_i)
        print(f"      email {str(row_id)[:8]}: parsed {len(rows_i):,} (new {kept:,})")
    print(f"      rows parsed (unioned): {len(parsed):,}")

    print("[3/5] Applying auction option filter")
    listings = [
        L for L in parsed
        if L.get("end_time_utc") and upload_filter(L["domain"])
    ]
    for L in listings:  # _parse_dt returns datetime; serialize for sheet/snapshot
        L["end_time_utc"] = L["end_time_utc"].isoformat()
    print(f"      qualifying auctions: {len(listings):,}")

    sheet_rows = [auctions_sheet.row_from_listing(L, now=now) for L in listings]
    print("[4/5] Writing to auctions sheet")
    sheet_stats = auctions_sheet.write(
        spreadsheet_id=sheet_id,
        new_rows=sheet_rows,
        source_id=SOURCE_ID,
    )
    print(f"      stats: {sheet_stats}")

    state.write_json(SOURCE_ID, SNAPSHOT_FILE, listings)

    slack_listings = []
    for L in listings:
        end_dt = datetime.fromisoformat(L["end_time_utc"].replace("Z", "+00:00"))
        slack_listings.append({**L, "time_left": auctions_sheet.format_time_left(end_dt, now=now)})

    if auctions.orchestrator_mode_active():
        print("[5/5] Slack post deferred to orchestrator")
        posted = False
    else:
        print(f"[5/5] Posting to Slack channel {slack_channel}")
        section = auctions_slack.format_section(label=SOURCE_LABEL, listings=slack_listings)
        posted = auctions_slack.post_consolidated(
            channel=slack_channel, source=SOURCE_ID, sections=[section], sheet_url=sheet_url,
        )
        print(f"      slack posted: {posted}")

    # Mark EVERY processed email (with its own parsed-row count), so a batch of
    # forwarded emails all clear instead of just the latest.
    for rid, cnt in per_email_count.items():
        _mark_processed(rid, cnt)

    state.write_json(SOURCE_ID, "run_status.json", {
        "source": SOURCE_ID,
        "label": SOURCE_LABEL,
        "status": "ok",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "emails_processed": len(stashed),
        "new_count": sheet_stats["added"],
        "sheet_total_after": sheet_stats["total_after"],
        "deduped_against_existing": sheet_stats["deduped"],
        "slack_posted": posted,
    })

    print("DONE")
    return 0
