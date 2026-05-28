"""Auctions cluster shared utilities.

The auctions_publish orchestrator runs each producer module in turn,
collecting per-source status into state/auctions/refresh_status.json and
posting one consolidated message to #auctions at the end.

Producers know they are being run inside the orchestrator via the
AUCTIONS_ORCHESTRATOR_MODE env var; when set, they skip posting their
own Slack section (the orchestrator will do it) but still write to the
auctions sheet and to their per-source state.
"""
from __future__ import annotations

import os

ORCHESTRATOR_ENV = "AUCTIONS_ORCHESTRATOR_MODE"


def orchestrator_mode_active() -> bool:
    """True if the current process is running inside the orchestrator."""
    return bool(os.environ.get(ORCHESTRATOR_ENV))
