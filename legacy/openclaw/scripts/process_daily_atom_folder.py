#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from io import BytesIO

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
STATE_PATH = DATA_DIR / "atom_folder_ingest_state.json"
PYTHON = BASE_DIR / ".venv" / "bin" / "python"
DRIVE_TOKEN = BASE_DIR / ".secrets" / "google_oauth_credentials.json"
ATOM_DIFF = BASE_DIR / "scripts" / "atom_diff.py"
ROTATE_DUMPS = BASE_DIR / "scripts" / "rotate_marketplace_dumps.py"
ATOM_FOLDER_ID = "1FFB8_8aTii5YQJheIQsJI0SqYRmFMg_4"
SCOPES = ["https://www.googleapis.com/auth/drive"]
TZ = ZoneInfo("America/New_York")


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True))


def python_bin() -> str:
    return str(PYTHON) if PYTHON.exists() else (shutil.which("python3") or shutil.which("python") or "python3")


def drive_service():
    creds = Credentials.from_authorized_user_file(str(DRIVE_TOKEN), scopes=SCOPES)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def today_names(now: datetime) -> tuple[str, str]:
    month = now.month
    day = now.day
    yy = now.strftime("%y")
    display = f"{month}-{day}-{yy} Atom Dump.csv"
    local = f"atom_partner_{now.strftime('%Y%m%d')}.csv"
    return display, local


def find_today_file(service, display_name: str) -> dict | None:
    query = (
        f"'{ATOM_FOLDER_ID}' in parents and trashed = false and name = '{display_name.replace("'", "\\'")}'"
    )
    resp = service.files().list(
        q=query,
        orderBy="modifiedTime desc",
        pageSize=5,
        fields="files(id,name,modifiedTime,size,webViewLink)",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get("files", [])
    return files[0] if files else None


def download_file(service, file_id: str) -> bytes:
    request = service.files().get_media(fileId=file_id, supportsAllDrives=True)
    fh = BytesIO()
    downloader = MediaIoBaseDownload(fh, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return fh.getvalue()


def run_atom_diff() -> None:
    subprocess.run([python_bin(), str(ATOM_DIFF)], cwd=str(BASE_DIR), check=True)


def rotate_dumps() -> None:
    subprocess.run([python_bin(), str(ROTATE_DUMPS)], cwd=str(BASE_DIR), check=True)


def main() -> int:
    now = datetime.now(TZ)
    today_iso = now.date().isoformat()
    now_iso = now.isoformat()
    display_name, local_name = today_names(now)
    state = load_state()
    alerts = state.setdefault("_alerts", {})

    service = drive_service()
    meta = find_today_file(service, display_name)
    if not meta:
        if today_iso not in alerts:
            alerts[today_iso] = {
                "type": "missing-upload",
                "file_name": display_name,
                "alerted_at": now_iso,
            }
            save_state(state)
        print(f"ALERT: today's Atom dump is missing from Drive: {display_name}")
        return 1

    existing = state.get(today_iso) or {}
    if existing.get("file_id") == meta["id"] and Path(existing.get("local_path", "")).exists():
        print(f"Already processed today's Atom dump: {display_name}")
        return 0

    local_path = DATA_DIR / local_name
    local_path.write_bytes(download_file(service, meta["id"]))
    run_atom_diff()
    rotate_dumps()

    state[today_iso] = {
        "source": "google-drive-folder",
        "folder_id": ATOM_FOLDER_ID,
        "file_id": meta["id"],
        "file_name": meta["name"],
        "local_path": str(local_path),
        "modified_time": meta.get("modifiedTime"),
        "processed_at": now_iso,
    }
    alerts.pop(today_iso, None)
    save_state(state)
    print(f"Processed Atom dump {display_name} -> {local_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
