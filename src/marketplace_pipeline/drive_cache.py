"""Tier 2 raw dump archive — writes to the Pipeline Raw Cache Drive folder.

Layout:
    Pipeline Raw Cache/<source_id>/<YYYY-MM-DD>/<filename>

Subfolders are created on demand. Cache writes are non-fatal — if the folder
ID is not configured, the call returns None and the pipeline continues.
"""
from __future__ import annotations

import io
import json
import os
from typing import Any

from . import config

SCOPES = ["https://www.googleapis.com/auth/drive"]

DEFAULT_MIME = "application/octet-stream"
EXT_MIME = {
    ".csv":  "text/csv",
    ".json": "application/json",
    ".zip":  "application/zip",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".txt":  "text/plain",
}


def _credentials():
    from google.oauth2.service_account import Credentials

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        path = os.environ.get("GOOGLE_SERVICE_ACCOUNT_FILE")
        if path and os.path.exists(path):
            raw = open(path).read()
    if not raw:
        raise RuntimeError(
            "GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_FILE must be set"
        )
    return Credentials.from_service_account_info(json.loads(raw), scopes=SCOPES)


def _drive_service():
    from googleapiclient.discovery import build

    return build("drive", "v3", credentials=_credentials(), cache_discovery=False)


def _root_folder_id() -> str | None:
    env = os.environ.get("PIPELINE_RAW_CACHE_FOLDER_ID")
    if env:
        return env
    reg = config.load_registry()
    return reg.get("storage", {}).get("pipeline_raw_cache_folder_id")


def _ensure_subfolder(service, parent_id: str, name: str) -> str:
    """Return the ID of <parent>/<name>, creating it if missing.

    Shared-Drive-safe: passes supportsAllDrives + includeItemsFromAllDrives
    so this works for both My Drive folders and Shared Drive folders.
    """
    # Escape single quotes per Drive query syntax
    safe = name.replace("'", "\\'")
    q = (
        f"'{parent_id}' in parents and name='{safe}' "
        f"and mimeType='application/vnd.google-apps.folder' and trashed=false"
    )
    res = service.files().list(
        q=q,
        fields="files(id,name)",
        pageSize=10,
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    files = res.get("files", [])
    if files:
        return files[0]["id"]
    file = service.files().create(
        body={
            "name": name,
            "mimeType": "application/vnd.google-apps.folder",
            "parents": [parent_id],
        },
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return file["id"]


def list_files_in_folder(
    folder_id: str,
    *,
    service: Any = None,
    page_size: int = 100,
) -> list[dict[str, Any]]:
    """List files in a Drive folder (Shared-Drive-safe).
    Returns a list of file metadata dicts with at least id, name, modifiedTime.
    """
    svc = service or _drive_service()
    res = svc.files().list(
        q=f"'{folder_id}' in parents and trashed=false",
        fields="files(id,name,modifiedTime,mimeType,size)",
        pageSize=page_size,
        orderBy="name",
        supportsAllDrives=True,
        includeItemsFromAllDrives=True,
    ).execute()
    return res.get("files", [])


def download_file(file_id: str, *, service: Any = None) -> bytes:
    """Download a Drive file's contents as bytes (Shared-Drive-safe)."""
    from googleapiclient.http import MediaIoBaseDownload

    svc = service or _drive_service()
    request = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _status, done = downloader.next_chunk()
    return buf.getvalue()


def cache_raw(
    *,
    source: str,
    report_date: str,
    filename: str,
    content: bytes,
    service: Any = None,
) -> str | None:
    """Upload a raw dump to Pipeline Raw Cache/<source>/<report_date>/<filename>.

    Returns the Drive file ID on success. Returns None (and logs) if the cache
    folder ID is not configured — intentionally non-fatal so the pipeline
    continues without Tier 2 storage.

    Shared-Drive-safe via supportsAllDrives=True.
    """
    root = _root_folder_id()
    if not root:
        print(
            f"drive_cache: PIPELINE_RAW_CACHE_FOLDER_ID not set; "
            f"skipping cache for {source}/{report_date}/{filename}"
        )
        return None

    svc = service or _drive_service()
    source_folder = _ensure_subfolder(svc, root, source)
    date_folder = _ensure_subfolder(svc, source_folder, report_date)

    from googleapiclient.http import MediaIoBaseUpload

    ext = os.path.splitext(filename)[1].lower()
    mime = EXT_MIME.get(ext, DEFAULT_MIME)
    # resumable=True is needed for files >5 MB to avoid timeouts; Namecheap
    # CSV is typically ~10-50 MB.
    media = MediaIoBaseUpload(io.BytesIO(content), mimetype=mime, resumable=True)

    file = svc.files().create(
        body={"name": filename, "parents": [date_folder]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    ).execute()
    return file["id"]
