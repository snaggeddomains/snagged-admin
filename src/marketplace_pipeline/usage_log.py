"""Best-effort API-cost logging from the pipeline into the MAIN research project's
``domain_research_api_usage`` table — the SAME table the research app writes to,
so pipeline spend (auctions/snap scrapers, LLM enrichment) shows up alongside
domain-owner reports etc. in the snagged-admin Reports → Cost tab.

One row per paid action. ``meter`` is a free-form key; ``units`` is the natural
billing unit (1 per request/call; LLM tokens in MILLIONS so the rate reads as
"$ / 1M tokens"); ``category`` is the activity/product ("enrichment", "auctions",
"snap", "aux"). Anthropic meters match the research app's naming
(``anthropic.<model>.input`` …) so the same model aggregates cleanly.

Never raises — cost logging must not break a pipeline run. Requires the research
project creds in the environment: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
"""

from __future__ import annotations

import os
from typing import Any, Optional

_M = 1_000_000
_client: Any = None
_client_tried = False


def _research_client():
    global _client, _client_tried
    if _client_tried:
        return _client
    _client_tried = True
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_SECRET_KEY")
    if not (url and key):
        return None
    try:
        from supabase import create_client

        _client = create_client(url, key)
    except Exception:
        _client = None
    return _client


def record_usage(meter: str, units: float, category: Optional[str] = None, meta: Optional[dict] = None) -> None:
    """Log one paid-action row. Best-effort; swallows every error."""
    try:
        if not meter:
            return
        n = float(units)
        if not (n > 0):
            return
        client = _research_client()
        if client is None:
            return
        row: dict[str, Any] = {"meter": meter, "units": n, "category": category}
        if meta is not None:
            row["meta"] = meta
        client.table("domain_research_api_usage").insert(row).execute()
    except Exception:
        pass


def record_model_usage(model: str, usage: dict, category: Optional[str] = None, batch: bool = False) -> None:
    """Log Anthropic token usage in MILLIONS of tokens under per-model meters.
    Accepts the pipeline's usage shape (in/out/cache_read/cache_write) or the
    SDK's (input_tokens/output_tokens/…). Batch-API spend gets a 'batch_' meter
    prefix so its 50%-off rate can be set separately."""
    if not usage:
        return
    m = str(model or "unknown")

    def g(*keys: str) -> float:
        for k in keys:
            v = usage.get(k)
            if v:
                return float(v)
        return 0.0

    inp = g("in", "input_tokens")
    out = g("out", "output_tokens")
    cr = g("cache_read", "cache_read_input_tokens")
    cw = g("cache_write", "cache_creation_input_tokens")
    pre = "batch_" if batch else ""
    record_usage(f"anthropic.{m}.{pre}input", inp / _M, category)
    record_usage(f"anthropic.{m}.{pre}output", out / _M, category)
    if cr:
        record_usage(f"anthropic.{m}.{pre}cache_read", cr / _M, category)
    if cw:
        record_usage(f"anthropic.{m}.{pre}cache_write", cw / _M, category)
