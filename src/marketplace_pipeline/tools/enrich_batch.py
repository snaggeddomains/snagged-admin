"""LLM enrichment via the Anthropic Message Batches API.

Same classification as the realtime `enrich` tool (it imports SYSTEM_PROMPT,
CATEGORIES, _clean, _parse_array, _apply_scope, PASSTHROUGH, TARGETS, ORDERINGS,
DEFAULT_ORDER, RATES, DEFAULT_MODEL from there — no duplication), but submitted
asynchronously: the Batches API is 50% cheaper and returns within ≤24h. Built
for the quality_score-banded bulk rollout where realtime concurrency isn't worth
the price.

Three actions drive it:

    pipeline enrich-batch submit  --target universe [--commit] [scope flags]
    pipeline enrich-batch status  [--target ...]
    pipeline enrich-batch collect [--target ...] [--batch-id ...]

  • submit pages the target table for rows needing enrichment (category IS NULL
    AND enriched_at IS NULL, or --reenrich), chunks domains, and creates one or
    more Anthropic batches (≤25000 requests each). Dry-run by DEFAULT — pass
    --commit to actually call the API and append batch metadata to
    state/enrichment/batches.jsonl.
  • status retrieves each submitted batch and prints its processing_status +
    request_counts.
  • collect retrieves ended batches, parses results, and upserts the enrichment
    columns onto the matching rows, then marks the batch "collected" in state.

State lives in state/enrichment/batches.jsonl — one JSON line per created batch:
    {"batch_id", "target", "model", "submitted_at", "n_requests", "status"}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from .enrich import (
    CATEGORIES,  # noqa: F401  (kept for parity / introspection)
    DEFAULT_MODEL,
    DEFAULT_ORDER,
    ORDERINGS,
    PASSTHROUGH,
    RATES,
    SYSTEM_PROMPT,
    TARGETS,
    _apply_scope,
    _clean,
    _parse_array,
)

STATE_PATH = Path("state/enrichment/batches.jsonl")
MAX_REQUESTS_PER_BATCH = 25000  # Anthropic per-batch request cap
COLLECT_UPSERT_CHUNK = 150  # rows per upsert on collect — small enough to stay
# under the DB statement timeout on the large, GIN-indexed name_universe table.


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _upsert_resilient(client, table, payload, *, _attempt: int = 0) -> int:
    """Upsert that survives DB statement timeouts (57014). name_universe is large
    with GIN array indexes, so a given batch size can intermittently exceed the
    statement timeout. On timeout we halve the payload and retry each half
    (adaptively finding a size that fits); a lone row that still times out backs
    off and retries a few times before giving up."""
    if not payload:
        return 0
    try:
        client.table(table).upsert(payload, on_conflict="domain").execute()
        return len(payload)
    except Exception as e:  # noqa: BLE001 — inspect message for the timeout code
        msg = str(e)
        if "57014" not in msg and "statement timeout" not in msg:
            raise
        if len(payload) > 1:
            mid = len(payload) // 2
            return _upsert_resilient(client, table, payload[:mid]) + \
                _upsert_resilient(client, table, payload[mid:])
        if _attempt < 4:
            time.sleep(2 ** _attempt)
            return _upsert_resilient(client, table, payload, _attempt=_attempt + 1)
        raise


def _env_name(target: str) -> str:
    return "SUPABASE_NAMING_*" if target == "universe" else "MASTERLIST_SUPABASE_*"


def _read_state() -> list[dict]:
    if not STATE_PATH.exists():
        return []
    out = []
    for line in STATE_PATH.read_text().splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _append_state(rec: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with STATE_PATH.open("a") as fh:
        fh.write(json.dumps(rec) + "\n")


def _rewrite_state(records: list[dict]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text("".join(json.dumps(r) + "\n" for r in records))


def _require_api_key() -> bool:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("enrich-batch: ANTHROPIC_API_KEY not set — cannot call the API.")
        return False
    return True


def _select_domains(client, table: str, target: str, args, model_order_key: str) -> list[str]:
    """Page the target table for domains needing enrichment, in priority order."""
    order_col, order_asc = ORDERINGS[model_order_key][target]
    now = _iso_now()
    domains: list[str] = []
    seen: set[str] = set()
    PAGE = 1000
    offset = 0
    while len(domains) < args.max_rows:
        q = client.table(table).select(", ".join(PASSTHROUGH[target]))
        if getattr(args, "refill_connotation", False):
            # Backfill the connotation field on rows enriched BEFORE the
            # connotation column existed (they have category/keywords but
            # connotation IS NULL). Re-runs the full prompt, refreshing every
            # field on those rows onto the current controlled vocab + connotation.
            q = q.is_("connotation", "null")
        elif args.reenrich:
            q = q.or_(f"enriched_at.is.null,enriched_at.lt.{now}")
        else:
            q = q.is_("category", "null").is_("enriched_at", "null")
        q = _apply_scope(q, target, args)
        q = q.order(order_col, desc=not order_asc, nullsfirst=False)
        q = q.range(offset, offset + PAGE - 1)
        rows = q.execute().data or []
        if not rows:
            break
        for r in rows:
            d = r.get("domain")
            if d and d not in seen:
                seen.add(d)
                domains.append(d)
                if len(domains) >= args.max_rows:
                    break
        if len(rows) < PAGE:
            break
        offset += PAGE
    return domains[: args.max_rows]


def _build_requests(domains: list[str], model: str, batch: int, max_tokens: int) -> list[dict]:
    requests = []
    for idx, i in enumerate(range(0, len(domains), batch)):
        chunk = domains[i : i + batch]
        requests.append({
            "custom_id": f"r{idx}",
            "params": {
                "model": model,
                "max_tokens": max_tokens,
                "system": [{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
                "messages": [{"role": "user", "content": "Domains:\n" + "\n".join(chunk)}],
            },
        })
    return requests


def _submit(args) -> int:
    factory, table, _ = TARGETS[args.target]
    client = factory()
    if client is None:
        print(f"enrich-batch: {_env_name(args.target)} not set — skipping.")
        return 0

    order_key = args.order or DEFAULT_ORDER[args.target]
    model = args.model or os.environ.get("ENRICHMENT_MODEL", DEFAULT_MODEL)

    domains = _select_domains(client, table, args.target, args, order_key)
    requests = _build_requests(domains, model, args.batch, args.max_tokens)
    n_requests = len(requests)
    # Domains per request (parallel to `requests`) so we can record/report the
    # true DOMAIN count per batch — the Anthropic counts are REQUESTS, not
    # domains (each request enriches up to `--batch` domains).
    req_counts = [len(domains[i : i + args.batch]) for i in range(0, len(domains), args.batch)]
    # Split into Anthropic-cap-sized submissions.
    submissions = [
        requests[i : i + MAX_REQUESTS_PER_BATCH]
        for i in range(0, n_requests, MAX_REQUESTS_PER_BATCH)
    ] or []
    n_batches = len(submissions)

    print(f"enrich-batch submit → {table} (model={model}, order={order_key}, "
          f"{'COMMIT' if args.commit else 'DRY-RUN'})")
    print(f"  ≈{len(domains):,} domains → {n_requests:,} requests "
          f"({args.batch}/req) in {n_batches} batch(es)")

    if not args.commit:
        print(f"  [dry-run] would create {n_batches} batch(es) of up to "
              f"{MAX_REQUESTS_PER_BATCH:,} requests; no API call, no state written.")
        return 0

    if n_requests == 0:
        print("  nothing to submit.")
        return 0

    if not _require_api_key():
        return 1

    from anthropic import Anthropic

    aclient = Anthropic()
    start = 0
    for sub in submissions:
        n_dom = sum(req_counts[start : start + len(sub)])
        batch = aclient.messages.batches.create(requests=sub)
        rec = {
            "batch_id": batch.id,
            "target": args.target,
            "model": model,
            "submitted_at": _iso_now(),
            "n_requests": len(sub),
            "n_domains": n_dom,
            "status": "submitted",
        }
        _append_state(rec)
        print(f"  created batch {batch.id} (≈{n_dom:,} domains, {len(sub):,} requests) → state.")
        start += len(sub)
    return 0


def _collect(args) -> int:
    factory, table, _ = TARGETS[args.target]
    client = factory()
    if client is None:
        print(f"enrich-batch: {_env_name(args.target)} not set — skipping.")
        return 0
    if not _require_api_key():
        return 1

    from anthropic import Anthropic

    aclient = Anthropic()
    records = _read_state()
    if not records:
        print("enrich-batch collect: no state — nothing to collect.")
        return 0

    for rec in records:
        if args.batch_id:
            if rec.get("batch_id") != args.batch_id:
                continue
        elif rec.get("status") != "submitted":
            continue
        if rec.get("target") != args.target:
            continue

        batch_id = rec["batch_id"]
        model = rec.get("model") or DEFAULT_MODEL
        batch = aclient.messages.batches.retrieve(batch_id)
        if batch.processing_status != "ended":
            print(f"  {batch_id}: {batch.processing_status} — skipping.")
            continue

        by_domain: dict[str, dict] = {}
        tin = tout = 0
        for entry in aclient.messages.batches.results(batch_id):
            if entry.result.type != "succeeded":
                continue
            msg = entry.result.message
            text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
            for r in _parse_array(text):
                d = str(r.get("domain") or "").strip().lower()
                if d:
                    by_domain[d] = _clean(r)
            u = msg.usage
            tin += getattr(u, "input_tokens", 0) or 0
            tout += getattr(u, "output_tokens", 0) or 0

        now = _iso_now()
        domains = list(by_domain)
        written = 0
        # Upsert in small chunks: name_universe is large with GIN indexes on the
        # emotions/keywords/industries arrays, so a 500-row upsert can exceed the
        # statement timeout (57014). 150 keeps each write well under it.
        for i in range(0, len(domains), COLLECT_UPSERT_CHUNK):
            chunk = domains[i : i + COLLECT_UPSERT_CHUNK]
            resp = (
                client.table(table)
                .select(", ".join(PASSTHROUGH[args.target]))
                .in_("domain", chunk)
                .execute()
            )
            row_by_domain = {r["domain"]: r for r in (resp.data or [])}
            payload = []
            for d, row in row_by_domain.items():
                rec_clean = by_domain.get(d.lower()) or by_domain.get(d) or {}
                item = {c: row[c] for c in PASSTHROUGH[args.target]}
                item.update({
                    "category": rec_clean.get("category"),
                    "connotation": rec_clean.get("connotation"),
                    "emotions": rec_clean.get("emotions") or [],
                    "keywords": rec_clean.get("keywords") or [],
                    "industries": rec_clean.get("industries") or [],
                    "enriched_at": now,
                    "enrichment_model": model,
                })
                payload.append(item)
            if payload:
                written += _upsert_resilient(client, table, payload)

        rec["status"] = "collected"
        print(f"  {batch_id}: ended — processed {len(domains):,} domains, "
              f"wrote {written:,} rows.")
        rate = RATES.get(model)
        if rate:
            cost = (tin / 1e6 * rate[0] + tout / 1e6 * rate[1]) * 0.5
            print(f"    tokens in {tin:,} / out {tout:,}; est. cost "
                  f"${cost:.2f} (Batch API 50% off).")

    _rewrite_state(records)
    return 0


def _status(args) -> int:
    if not _require_api_key():
        return 1

    from anthropic import Anthropic

    aclient = Anthropic()
    records = _read_state()
    if not records:
        print("enrich-batch status: no state.")
        return 0

    for rec in records:
        if rec.get("status") != "submitted":
            continue
        batch_id = rec["batch_id"]
        batch = aclient.messages.batches.retrieve(batch_id)
        dom = rec.get("n_domains")
        dom_str = f"≈{dom:,} domains, " if isinstance(dom, int) else ""
        # request_counts are REQUESTS (each ≈ --batch domains), not domains.
        print(f"  {batch_id}  target={rec.get('target')}  "
              f"status={batch.processing_status}  "
              f"{dom_str}requests={batch.request_counts}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline enrich-batch")
    ap.add_argument("action", choices=["submit", "collect", "status"])
    ap.add_argument("--target", choices=list(TARGETS), default="universe")
    ap.add_argument("--commit", action="store_true",
                    help="actually call the API + write state (submit; default: dry-run)")
    ap.add_argument("--max-rows", type=int, default=100000, help="cap rows submitted")
    ap.add_argument("--batch", type=int, default=25, help="domains per batch request")
    ap.add_argument("--model", default=None, help="override enrichment model")
    ap.add_argument("--max-tokens", type=int, default=4000, help="output token ceiling per request")
    ap.add_argument("--order", choices=list(ORDERINGS), default=None,
                    help="row priority (default: universe=quality, master=domain)")
    ap.add_argument("--tld", default=None, help="restrict to a TLD (e.g. com)")
    ap.add_argument("--single-word", action="store_true", help="only one-word names")
    ap.add_argument("--dict-word", action="store_true", help="only dictionary-word names")
    ap.add_argument("--quality-min", type=float, default=None, help="quality_score >= (universe)")
    ap.add_argument("--quality-max", type=float, default=None, help="quality_score < (universe)")
    ap.add_argument("--source", default=None,
                    help="restrict to one source (universe sources[] membership / master source text)")
    ap.add_argument("--len-max", type=int, default=None, help="sld_length <=")
    ap.add_argument("--no-numbers", action="store_true", help="exclude names containing digits")
    ap.add_argument("--reenrich", action="store_true",
                    help="re-do every row in scope, overwriting existing enrichment")
    ap.add_argument("--refill-connotation", action="store_true",
                    help="select rows where connotation IS NULL (backfill the "
                         "connotation field on rows enriched before that column existed)")
    ap.add_argument("--batch-id", default=None, help="collect/status a single batch id")
    args = ap.parse_args(argv)

    if args.max_rows is None:
        args.max_rows = 100000

    if args.action == "submit":
        return _submit(args)
    if args.action == "collect":
        return _collect(args)
    return _status(args)


if __name__ == "__main__":
    sys.exit(main())
