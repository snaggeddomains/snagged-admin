#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

BASE_DIR = Path('/root/.openclaw/workspace')
TOKEN_PATH = BASE_DIR / '.secrets' / 'google_oauth_credentials.json'
STATE_PATH = BASE_DIR / 'data' / 'atom_drive_retention_state.json'
LIVE_FOLDER_ID = '1FFB8_8aTii5YQJheIQsJI0SqYRmFMg_4'
LIVE_FOLDER_NAME = 'Atom Dumps'
ARCHIVE_FOLDER_NAME = 'Atom Dumps Archive'
SCOPES = ['https://www.googleapis.com/auth/drive']
LIVE_KEEP_DAYS = 14
ARCHIVE_KEEP_DAYS = 30
FILE_RE = re.compile(r'^(\d{1,2})-(\d{1,2})-(\d{2}) Atom Dump\.csv$', re.I)
UTC = timezone.utc


def load_state() -> dict:
    if not STATE_PATH.exists():
        return {}
    try:
        return json.loads(STATE_PATH.read_text())
    except json.JSONDecodeError:
        return {}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True) + '\n')


def drive_service():
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), scopes=SCOPES)
    return build('drive', 'v3', credentials=creds, cache_discovery=False)


def parse_file_date(name: str, modified_time: str | None) -> datetime:
    match = FILE_RE.match(name.strip())
    if match:
        month, day, year = match.groups()
        year4 = 2000 + int(year)
        return datetime(year4, int(month), int(day), tzinfo=UTC)
    if modified_time:
        return datetime.fromisoformat(modified_time.replace('Z', '+00:00')).astimezone(UTC)
    return datetime.now(UTC)


def get_folder(service, folder_id: str) -> dict:
    return service.files().get(
        fileId=folder_id,
        fields='id,name,parents',
        supportsAllDrives=True,
    ).execute()


def ensure_archive_folder(service, live_folder: dict) -> dict:
    parent_ids = live_folder.get('parents', [])
    parent_query = ' and '.join([f"'{pid}' in parents" for pid in parent_ids]) or "'root' in parents"
    q = (
        f"mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '{ARCHIVE_FOLDER_NAME}'"
        + (f' and {parent_query}' if parent_query else '')
    )
    resp = service.files().list(
        q=q,
        pageSize=5,
        fields='files(id,name,parents)',
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = resp.get('files', [])
    if files:
        return files[0]
    body = {
        'name': ARCHIVE_FOLDER_NAME,
        'mimeType': 'application/vnd.google-apps.folder',
        'parents': parent_ids or ['root'],
    }
    return service.files().create(
        body=body,
        fields='id,name,parents',
        supportsAllDrives=True,
    ).execute()


def list_folder_files(service, folder_id: str) -> list[dict]:
    q = f"'{folder_id}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'"
    out = []
    page_token = None
    while True:
        resp = service.files().list(
            q=q,
            orderBy='modifiedTime desc',
            pageSize=200,
            pageToken=page_token,
            fields='nextPageToken,files(id,name,modifiedTime,size,parents,webViewLink)',
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()
        out.extend(resp.get('files', []))
        page_token = resp.get('nextPageToken')
        if not page_token:
            break
    return out


def move_file(service, file_id: str, add_parent: str, remove_parents: list[str]) -> None:
    service.files().update(
        fileId=file_id,
        addParents=add_parent,
        removeParents=','.join(remove_parents),
        fields='id,parents',
        supportsAllDrives=True,
    ).execute()


def trash_file(service, file_id: str) -> None:
    service.files().update(
        fileId=file_id,
        body={'trashed': True},
        fields='id,trashed',
        supportsAllDrives=True,
    ).execute()


def main() -> int:
    now = datetime.now(UTC)
    live_cutoff = now - timedelta(days=LIVE_KEEP_DAYS)
    archive_cutoff = now - timedelta(days=ARCHIVE_KEEP_DAYS)
    state = load_state()
    service = drive_service()
    live_folder = get_folder(service, LIVE_FOLDER_ID)
    archive_folder = ensure_archive_folder(service, live_folder)

    moved = []
    deleted = []

    for meta in list_folder_files(service, LIVE_FOLDER_ID):
        file_dt = parse_file_date(meta['name'], meta.get('modifiedTime'))
        if file_dt < live_cutoff:
            move_file(service, meta['id'], archive_folder['id'], meta.get('parents', [LIVE_FOLDER_ID]))
            moved.append({
                'id': meta['id'],
                'name': meta['name'],
                'from': LIVE_FOLDER_NAME,
                'to': ARCHIVE_FOLDER_NAME,
                'file_date': file_dt.date().isoformat(),
            })

    for meta in list_folder_files(service, archive_folder['id']):
        file_dt = parse_file_date(meta['name'], meta.get('modifiedTime'))
        if file_dt < archive_cutoff:
            trash_file(service, meta['id'])
            deleted.append({
                'id': meta['id'],
                'name': meta['name'],
                'from': ARCHIVE_FOLDER_NAME,
                'file_date': file_dt.date().isoformat(),
            })

    state['last_run'] = {
        'ran_at': now.isoformat(),
        'live_keep_days': LIVE_KEEP_DAYS,
        'archive_keep_days': ARCHIVE_KEEP_DAYS,
        'archive_folder_id': archive_folder['id'],
        'moved_count': len(moved),
        'deleted_count': len(deleted),
        'moved': moved,
        'deleted': deleted,
    }
    save_state(state)
    print(json.dumps(state['last_run'], indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
