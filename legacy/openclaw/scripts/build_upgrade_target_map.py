#!/usr/bin/env python3
"""Build or refresh the curated upgrade-target map for active accelerator startups."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import List

from google.oauth2 import service_account
from googleapiclient.discovery import build

BASE_DIR = Path(__file__).resolve().parent.parent
SHEET_ID = "1Rq_l8nNQ_zn26mrM6PgJ6dXS3h17R-PIeY3BCNF8OKE"
ACC_TAB = "Accelerators"
OUTPUT = BASE_DIR / "data" / "accelerator_upgrade_targets.json"
SERVICE_ACCOUNT_CANDIDATES = [
    BASE_DIR / ".secrets" / "google_service_account.json",
    Path("/root/.secrets/google_service_account.json"),
    Path("/root/.secrets/google-gmail.json"),
]
SCOPES = ["https://www.googleapis.com/auth/spreadsheets"]
ALLOWED_PREFIXES = ["get", "try", "use", "go", "hey"]


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


def split_domain(domain: str) -> tuple[str, str]:
    domain = (domain or "").strip().lower()
    if "." not in domain:
        return domain, ""
    return domain.rsplit(".", 1)


def strip_allowed_prefix(sld: str) -> str:
    for prefix in ALLOWED_PREFIXES:
        if sld.startswith(prefix) and len(sld) - len(prefix) >= 3:
            return sld[len(prefix) :]
    return sld


def build_targets_for_domain(current_domain: str) -> List[str]:
    sld, tld = split_domain(current_domain)
    if not sld or not tld:
        return []

    root = strip_allowed_prefix(sld)
    targets: List[str] = []
    seen = set()

    def add(domain: str):
        candidate = (domain or "").strip().lower()
        if not candidate or candidate == current_domain or "." not in candidate or "-" in candidate:
            return
        if candidate not in seen:
            seen.add(candidate)
            targets.append(candidate)

    if root != sld:
        add(f"{root}.com")
        add(f"{root}.ai")
        if tld == "ai":
            add(f"{sld}.com")
        return targets

    if tld == "com":
        return []

    if tld == "ai":
        add(f"{sld}.com")
        return targets

    add(f"{sld}.com")
    return targets


def main() -> None:
    service = build_sheets_service()
    acc_rows = load_sheet(service, ACC_TAB, "A1:Z")
    if not acc_rows:
        raise SystemExit("No accelerator data found.")

    headers = acc_rows[0]
    acc_data = [dict(zip(headers, row + [""] * (len(headers) - len(row)))) for row in acc_rows[1:]]

    records: List[dict] = []
    for row in acc_data:
        if (row.get("site_active") or "").strip().lower() != "active":
            continue
        startup_name = (row.get("startup_name") or "").strip()
        current_domain = (row.get("domain") or "").strip().lower()
        if not startup_name or not current_domain:
            continue

        records.append(
            {
                "startup_name": startup_name,
                "current_domain": current_domain,
                "accelerator": row.get("accelerator") or "",
                "cohort": row.get("cohort") or "",
                "industry_category": row.get("industry_category") or "",
                "all_locations": row.get("all_locations") or "",
                "site_active": row.get("site_active") or "",
                "targets": build_targets_for_domain(current_domain),
            }
        )

    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "sheet_id": SHEET_ID,
        "rules": {
            "brand_com_has_no_upgrades": True,
            "brand_ai_upgrades_to": ["brand.com"],
            "allowed_prefixes": ALLOWED_PREFIXES,
            "prefix_upgrade_targets": ["root.com", "root.ai"],
            "notes": [
                "Do not force 4-6 targets.",
                "Do not add suffixes like Labs or Global.",
                "For prefixed .ai domains, same multi-word .com is also an upgrade.",
                "Proposed upgrades must never include a hyphen.",
                "Unpriced Sedo broker pages do not count as upgrades.",
            ],
        },
        "records": sorted(records, key=lambda r: (r["startup_name"].lower(), r["current_domain"])),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, indent=2))
    print(f"[INFO] Wrote {len(records)} active startup records to {OUTPUT}.")


if __name__ == "__main__":
    main()
