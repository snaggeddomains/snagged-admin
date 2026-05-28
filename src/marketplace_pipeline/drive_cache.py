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
    """Return the ID of <parent>/<name>, creating it if missing."""
    # Escape single quotes in folder names by doubling them per Drive query syntax
    safe = name.replace("'", "\\'")
    q = (
        f"'{parent_id}' in parents and name='{safe}' "
        f"and mimeType='application/vnd.google-apps.folder' and trashed=false"
    )
    res = service.files().list(q=q, fields="files(id,name)", pageSize=10).execute()
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
    ).execute()
    return file["id"]


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
    media = MediaIoBaseUpload(io.BytesIO(content), mimetype=mime, resumable=False)

    file = svc.files().create(
        body={"name": filename, "parents": [date_folder]},
        media_body=media,
        fields="id",
    ).execute()
    return file["id"]
