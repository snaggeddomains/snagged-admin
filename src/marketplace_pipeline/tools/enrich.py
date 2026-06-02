"""LLM enrichment for the domain corpora.

Fills the four enrichment columns — category (text), emotions (text[]),
keywords (text[]), industries (text[]) — on rows that don't have them yet, by
asking an LLM to read each second-level name and infer its meaning. Works
against either store:

    pipeline enrich --target universe   # name_universe   (SUPABASE_NAMING_*)
    pipeline enrich --target master     # Master Domain List (MASTERLIST_*)

Designed to survive the planned consolidation of Master into the naming project:
each store is reached through its own env-configured client, so co-locating them
later is just an env change (and the cross-table copy below becomes a one-project
SQL UPDATE…FROM).

Cost & safety rails (this hits a paid API):
  • Dry-run by DEFAULT. Nothing is written or charged unless you pass --commit.
  • --max-rows caps how many rows a single run will process (default 500).
  • --batch domains per LLM call (default 25) — batching amortizes the cached
    system prompt and cuts per-row overhead.
  • --copy-overlap (default on): before paying, fill the target's missing rows
    from the OTHER store where the same domain is already enriched — free.

Resumable & failure-safe via two tracking columns (run setup SQL once):
    alter table name_universe        add column if not exists enriched_at timestamptz;
    alter table name_universe        add column if not exists enrichment_model text;
    alter table "Master Domain List" add column if not exists industries text[];
    alter table "Master Domain List" add column if not exists enriched_at timestamptz;
    alter table "Master Domain List" add column if not exists enrichment_model text;
    -- speed: only scan unenriched rows
    create index if not exists idx_universe_needs_enrich
      on name_universe (domain) where category is null and enriched_at is null;

Selection predicate is `category IS NULL AND enriched_at IS NULL`, so:
  • legacy rows already carrying a category are left alone (never re-charged);
  • every attempted row gets enriched_at stamped (success or fail), so failures
    aren't retried in a loop. Re-run with --retry-failed to revisit rows that
    were attempted but came back empty (enriched_at set, category still null).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

from ..universe.supabase_writer import _client_or_none as _naming_client

ENRICH_COLS = ("category", "emotions", "keywords", "industries")

# Per-model $/MTok (input, output) — rough, for the run-cost estimate only.
RATES = {
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-opus-4-8": (15.00, 75.00),
}
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

SYSTEM_PROMPT = """You classify domain names for a domain marketplace.

For each domain you are given, read the second-level name (the part before the
TLD) and infer what it evokes — treat it as a potential brand. Output, per domain:

- category:  ONE concise Title Case label for its primary theme
             (e.g. "Tech", "Finance", "Health", "Travel", "Food & Drink").
- emotions:  1-4 feelings the name evokes, each a single Capitalized word
             (e.g. "Trust", "Wonder", "Playful", "Bold"). [] if none fit.
- keywords:  5-15 lowercase topical words/associations a buyer would search.
- industries: 1-5 lowercase industry tags the name suits (e.g. "fintech",
             "ecommerce", "saas", "healthcare").

Base everything on the name's meaning and sound, not on whether it's for sale.

Return ONLY a JSON array — one object per input domain, in the SAME order, with
keys exactly: domain, category, emotions, keywords, industries. No prose, no
markdown fences."""


def _master_client():
    url = os.environ.get("MASTERLIST_SUPABASE_URL")
    key = os.environ.get("MASTERLIST_SUPABASE_SECRET_KEY")
    if not (url and key):
        return None
    from supabase import create_client

    return create_client(url, key)


# target -> (client factory, table name, has-industries-column)
TARGETS = {
    "universe": (_naming_client, "name_universe", True),
    "master": (_master_client, "Master Domain List", True),
}


def _norm_list(v, *, lower: bool) -> list[str]:
    """Coerce model output to a clean list[str] with consistent casing."""
    if not isinstance(v, list):
        v = [v] if v else []
    out, seen = [], set()
    for x in v:
        s = str(x).strip()
        if not s:
            continue
        # keywords/industries lowercase; emotions Title-cased to match the search
        # filter's titleCase() (charAt(0).upper + rest.lower) so array matches hit.
        s = s.lower() if lower else (s[:1].upper() + s[1:].lower())
        if s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


def _clean(rec: dict) -> dict:
    """Normalize one model record into the column shape we write."""
    cat = str(rec.get("category") or "").strip() or None
    return {
        "category": cat,
        "emotions": _norm_list(rec.get("emotions"), lower=False),
        "keywords": _norm_list(rec.get("keywords"), lower=True),
        "industries": _norm_list(rec.get("industries"), lower=True),
    }


def _parse_array(text: str) -> list[dict]:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("```", 2)[1] if "```" in t[3:] else t.strip("`")
        t = t.lstrip("json").strip()
    start, end = t.find("["), t.rfind("]")
    if start == -1 or end == -1:
        return []
    try:
        data = json.loads(t[start : end + 1])
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _enrich_batch(anthropic_client, model: str, domains: list[str], max_tokens: int):
    """One LLM call for a batch. Returns (by_domain dict, usage dict)."""
    resp = anthropic_client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": "Domains:\n" + "\n".join(domains)}],
    )
    text = "".join(b.text for b in resp.content if getattr(b, "type", None) == "text")
    by_domain = {}
    for rec in _parse_array(text):
        d = str(rec.get("domain") or "").strip().lower()
        if d:
            by_domain[d] = _clean(rec)
    u = resp.usage
    usage = {
        "in": getattr(u, "input_tokens", 0) or 0,
        "out": getattr(u, "output_tokens", 0) or 0,
        "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0,
        "cache_write": getattr(u, "cache_creation_input_tokens", 0) or 0,
    }
    return by_domain, usage


def _copy_overlap(other_client, other_table, domains: list[str]) -> dict[str, dict]:
    """Pull already-enriched records from the OTHER store for these domains."""
    if other_client is None or not domains:
        return {}
    found = {}
    CHUNK = 200
    for i in range(0, len(domains), CHUNK):
        sub = domains[i : i + CHUNK]
        resp = (
            other_client.table(other_table)
            .select("domain, category, emotions, keywords, industries")
            .in_("domain", sub)
            .not_.is_("category", "null")
            .execute()
        )
        for r in resp.data or []:
            d = (r.get("domain") or "").lower()
            if d and r.get("category"):  # guard: only copy actually-enriched rows
                found[d] = {
                    "category": r.get("category"),
                    "emotions": r.get("emotions") or [],
                    "keywords": r.get("keywords") or [],
                    "industries": r.get("industries") or [],
                }
    return found


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline enrich")
    ap.add_argument("--target", choices=list(TARGETS), required=True)
    ap.add_argument("--commit", action="store_true", help="actually call the API + write (default: dry-run)")
    ap.add_argument("--max-rows", type=int, default=500, help="cap rows processed this run")
    ap.add_argument("--batch", type=int, default=25, help="domains per LLM call")
    ap.add_argument("--model", default=os.environ.get("ENRICHMENT_MODEL", DEFAULT_MODEL))
    ap.add_argument("--max-tokens", type=int, default=4000, help="output token ceiling per call")
    ap.add_argument("--no-copy-overlap", action="store_true", help="skip the free cross-store copy step")
    ap.add_argument("--retry-failed", action="store_true",
                    help="revisit rows attempted before but still empty (enriched_at set, category null)")
    args = ap.parse_args(argv)

    factory, table, _ = TARGETS[args.target]
    client = factory()
    if client is None:
        env = "SUPABASE_NAMING_*" if args.target == "universe" else "MASTERLIST_SUPABASE_*"
        print(f"enrich: {env} not set — skipping.")
        return 0

    # the other store, for the free overlap copy
    other_key = "master" if args.target == "universe" else "universe"
    other_factory, other_table, _ = TARGETS[other_key]
    other_client = None if args.no_copy_overlap else other_factory()

    model = args.model
    rate = RATES.get(model)
    print(f"enrich → {table} (model={model}, {'COMMIT' if args.commit else 'DRY-RUN'}, "
          f"max_rows={args.max_rows}, batch={args.batch})")

    anthropic_client = None
    if args.commit:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("enrich: ANTHROPIC_API_KEY not set — cannot --commit.")
            return 1
        from anthropic import Anthropic

        anthropic_client = Anthropic()

    processed = copied = llm_filled = failed = 0
    tot = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0}
    now = datetime.now(timezone.utc).isoformat()

    while processed < args.max_rows:
        limit = min(args.batch, args.max_rows - processed)
        q = (
            client.table(table)
            .select("domain")
            .is_("category", "null")
            .order("domain")
            .limit(limit)
        )
        q = q.not_.is_("enriched_at", "null") if args.retry_failed else q.is_("enriched_at", "null")
        rows = q.execute().data or []
        if not rows:
            break
        domains = [r["domain"] for r in rows]

        # 1) free cross-store copy for any overlap
        results: dict[str, dict] = {}
        if other_client is not None:
            overlap = _copy_overlap(other_client, other_table, domains)
            for d, rec in overlap.items():
                results[d] = rec
            copied += len(overlap)

        # 2) LLM the remainder
        todo = [d for d in domains if d not in results]
        if todo:
            if not args.commit:
                print(f"  [dry-run] would enrich {len(todo)} via LLM "
                      f"(+{len(domains) - len(todo)} copied free): {todo[:3]}…")
            else:
                by_domain, usage = _enrich_batch(anthropic_client, model, todo, args.max_tokens)
                for k in tot:
                    tot[k] += usage[k]
                for d in todo:
                    results[d] = by_domain.get(d) or {
                        "category": None, "emotions": [], "keywords": [], "industries": []
                    }
                llm_filled += sum(1 for d in todo if results[d]["category"])
                failed += sum(1 for d in todo if not results[d]["category"])

        # 3) write
        if args.commit:
            payload = []
            for d in domains:
                rec = results.get(d) or {}
                payload.append({
                    "domain": d,
                    "category": rec.get("category"),
                    "emotions": rec.get("emotions") or [],
                    "keywords": rec.get("keywords") or [],
                    "industries": rec.get("industries") or [],
                    "enriched_at": now,
                    "enrichment_model": model,
                })
            client.table(table).upsert(payload, on_conflict="domain").execute()

        processed += len(domains)
        print(f"  processed {processed:,} (copied {copied:,}, llm {llm_filled:,}, "
              f"empty {failed:,})", flush=True)
        if not args.commit:
            break  # one sample page is enough to preview cost/shape

    print(f"\nDONE — processed {processed:,}: {copied:,} copied free, "
          f"{llm_filled:,} LLM-enriched, {failed:,} came back empty.")
    if args.commit and any(tot.values()):
        print(f"Tokens — in {tot['in']:,} (cache_read {tot['cache_read']:,}, "
              f"write {tot['cache_write']:,}), out {tot['out']:,}.")
        if rate:
            cost = (tot["in"] + tot["cache_read"]) / 1e6 * rate[0] + tot["out"] / 1e6 * rate[1]
            print(f"Est. cost this run: ${cost:.2f} (≈${cost / max(processed,1) * 1000:.2f}/1k rows).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
