"""Shared schemas for the marketplace pipeline.

These models are the contract between every layer:
  fetch -> normalize -> filter -> diff -> publish.

See docs/domain-dumps-and-platform-workflows-spec.md section 5 for the design.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


SourceStatusValue = Literal["pending", "ok", "failed", "disabled", "skipped"]
Product = Literal["snap", "auctions", "aux"]


class MarketListing(BaseModel):
    """A listing surfaced by SNAP-style sources (Afternic, Namecheap BIN, Atom, ...)."""

    source: str
    domain: str
    sld: str
    tld: str
    price: float | None = None
    currency: str = "USD"
    link: str | None = None
    zipf_score: float | None = None
    quality_score: float | None = None
    deal_score: float | None = None
    fast_transfer: bool = False
    report_date: str
    raw_source_file: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class AuctionListing(BaseModel):
    """A listing surfaced by an auction-platform source."""

    source: str
    domain: str
    platform: str
    end_time_utc: datetime
    price: float | None = None
    currency: str = "USD"
    bid_count: int | None = None
    link: str | None = None
    source_file: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SourceStatus(BaseModel):
    """Per-source health status, written into state/<source>/run_status.json
    and aggregated into state/auctions/refresh_status.json by the orchestrator.
    """

    source: str
    label: str
    status: SourceStatusValue
    detail: str = ""
    generated_at: datetime


class SnapshotContract(BaseModel):
    """A snapshot of listings from one source at one point in time."""

    source: str
    generated_at: datetime
    report_date: str
    items: list[MarketListing] | list[AuctionListing]
