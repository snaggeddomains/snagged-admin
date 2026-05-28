"""Pipeline state read/write helpers.

All state is JSON committed to /state/<source_id>/. A GitHub Actions workflow
reads previous snapshots at run start and commits new ones at run end.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = REPO_ROOT / "state"


def state_path(source: str, filename: str) -> Path:
    return STATE_DIR / source / filename


def read_json(source: str, filename: str, default: Any = None) -> Any:
    p = state_path(source, filename)
    if not p.exists():
        return default
    return json.loads(p.read_text())


def write_json(source: str, filename: str, data: Any) -> None:
    p = state_path(source, filename)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, indent=2, default=str, sort_keys=True) + "\n")
