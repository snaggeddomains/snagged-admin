"""Thin CLI entrypoint for the auctions watchdog (see auctions/watchdog.py)."""
from __future__ import annotations

from ..auctions.watchdog import run, WATCHDOG_ID as SOURCE_ID

SOURCE_LABEL = "Auctions watchdog"

__all__ = ["run", "SOURCE_ID", "SOURCE_LABEL"]
