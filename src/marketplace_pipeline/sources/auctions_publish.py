"""Thin CLI entrypoint for the auctions_publish orchestrator.

The orchestrator implementation lives in
src/marketplace_pipeline/auctions/orchestrator.py so it can be imported
without going through this sources/* dispatch path. This file exists
only so `pipeline run auctions_publish` resolves to the same code via the
CLI's dynamic-import dispatch.
"""
from __future__ import annotations

from ..auctions.orchestrator import run, ORCHESTRATOR_ID as SOURCE_ID

SOURCE_LABEL = "Auctions publish"

__all__ = ["run", "SOURCE_ID", "SOURCE_LABEL"]
