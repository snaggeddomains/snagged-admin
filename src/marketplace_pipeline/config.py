"""Source registry loader.

sources.yaml is the single source of truth for what runs, on what schedule,
into what destinations.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
REGISTRY_PATH = REPO_ROOT / "sources.yaml"


def load_registry() -> dict[str, Any]:
    return yaml.safe_load(REGISTRY_PATH.read_text())


def get_source(source_id: str) -> dict[str, Any]:
    reg = load_registry()
    sources = {s["source_id"]: s for s in reg.get("sources", [])}
    if source_id not in sources:
        raise KeyError(f"Unknown source: {source_id}")
    return sources[source_id]


def list_sources(product: str | None = None, enabled_only: bool = False) -> list[dict[str, Any]]:
    reg = load_registry()
    items = reg.get("sources", [])
    if product:
        items = [s for s in items if s.get("product") == product]
    if enabled_only:
        items = [s for s in items if s.get("enabled", True)]
    return items
