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
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from ..universe.supabase_writer import _client_or_none as _naming_client

ENRICH_COLS = ("category", "connotation", "emotions", "keywords", "industries")

# Per-model $/MTok (input, output) — rough, for the run-cost estimate only.
RATES = {
    "claude-haiku-4-5-20251001": (1.00, 5.00),
    "claude-sonnet-4-6": (3.00, 15.00),
    "claude-opus-4-8": (15.00, 75.00),
}
DEFAULT_MODEL = "claude-haiku-4-5-20251001"

# Controlled category vocabulary — the model must pick exactly one (verbatim);
# anything else normalizes to "General & Other". Keeps buckets clean for the
# DB Search category filter.
CATEGORIES = [
    "Technology & Software", "Internet & Web", "AI & Data", "Finance & Fintech",
    "Crypto & Web3", "E-Commerce & Retail", "Business & Professional",
    "Marketing & Advertising", "Media & Publishing", "Entertainment & Gaming",
    "Social & Community", "Education & Learning", "Health & Wellness",
    "Medical & Biotech", "Food & Drink", "Travel & Hospitality",
    "Real Estate & Property", "Home & Living", "Fashion & Beauty",
    "Sports & Fitness", "Automotive & Transport", "Energy & Environment",
    "Legal & Government", "Nonprofit & Causes", "Family & Parenting",
    "Arts & Design", "Science & Research", "Pets & Animals",
    "Dating & Relationships", "Lifestyle", "General & Other",
]
CATEGORY_BY_LOWER = {c.lower(): c for c in CATEGORIES}
FALLBACK_CATEGORY = "General & Other"

SYSTEM_PROMPT = """You classify domain names for a domain marketplace.

For each domain you are given, read the second-level name (the part before the
TLD) and infer what it evokes — treat it as a potential brand. Output, per domain:

- category:  choose EXACTLY ONE label from this list, copied verbatim:
""" + "\n".join("             " + c for c in CATEGORIES) + """
             Pick the single best fit; use "General & Other" only if nothing
             else applies.
- connotation: the name's overall sentiment as a brand — exactly one of
             "positive", "somewhat positive", "neutral", "somewhat negative",
             or "negative" (lowercase). Most names are "neutral"; reserve the
             negative grades for words with genuinely unfavorable associations
             (e.g. divorce, scam, toxic, death).
- emotions:  1-4 feelings the name evokes, each a single Capitalized word
             (e.g. "Trust", "Wonder", "Playful", "Bold"). [] if none fit.
- keywords:  5-15 lowercase topical words/associations a buyer would search.
- industries: 1-5 lowercase industry tags the name suits (e.g. "fintech",
             "ecommerce", "saas", "healthcare").

Base everything on the name's meaning and sound, not on whether it's for sale.

Return ONLY a JSON array — one object per input domain, in the SAME order, with
keys exactly: domain, category, connotation, emotions, keywords, industries.
No prose, no markdown fences."""

VALID_CONNOTATION = {"positive", "somewhat positive", "neutral", "somewhat negative", "negative"}


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

# Columns echoed back unchanged on upsert. PostgREST upsert is INSERT-on-conflict,
# so any NOT-NULL column without a default must be present or the INSERT branch
# fails (23502) even though only existing rows are ever touched. Universe needs
# its identity/date columns; Master's only NOT NULLs (id/created_at/updated_at)
# have defaults, so domain alone suffices.
PASSTHROUGH = {
    "universe": ["domain", "sld", "tld", "sld_length", "first_seen", "last_seen", "sources", "source_tier"],
    "master": ["domain"],
}

# Process the most valuable rows first so a budget-capped run spends on good
# names. `--order` picks the key; we fall back to `domain` where a table lacks
# the column. (col, ascending) per target.
ORDERINGS = {
    "quality": {"universe": ("quality_score", False), "master": ("quality_score", False)},
    "price":   {"universe": ("best_price", False),    "master": ("price", False)},
    "domain":  {"universe": ("domain", True),         "master": ("domain", True)},
}
DEFAULT_ORDER = {"universe": "quality", "master": "domain"}


def _apply_scope(q, target: str, args):
    """Narrow the selection to a slice (e.g. one-word dictionary .com), mapping
    flags to each table's columns. Universe uses num_words/is_dictionary_word
    (bool); Master uses is_single_word/dictionary_word (TEXT 'Y')."""
    if args.tld:
        t = args.tld.lower().lstrip(".")
        # Universe stores TLD bare ('com') — an exact match keeps the composite
        # enrich-queue index's ordering usable. Master may carry legacy dotted
        # rows, so match both there.
        q = q.eq("tld", t) if target == "universe" else q.in_("tld", [t, "." + t])
        q = q.not_.like("domain", "%.%.%")  # clean sld.tld only
    if args.single_word:
        q = q.eq("num_words", 1) if target == "universe" else q.eq("is_single_word", "Y")
    if args.dict_word:
        q = q.eq("is_dictionary_word", True) if target == "universe" else q.eq("dictionary_word", "Y")
    # quality_score banding now applies to BOTH corpora — Master's quality_score
    # was backfilled 2026-06 with the same wordfreq×tld formula as Universe.
    if getattr(args, "quality_min", None) is not None:
        q = q.gte("quality_score", args.quality_min)
    if getattr(args, "quality_max", None) is not None:
        q = q.lt("quality_score", args.quality_max)
    # hygiene filters apply to both corpora
    if getattr(args, "len_max", None) is not None:
        q = q.lte("sld_length", args.len_max)
    if getattr(args, "no_numbers", False):
        q = q.not_.match("sld" if target == "universe" else "domain", "[0-9]")
    # Restrict to one source (used by the import → auto-enrich chain, so a small
    # import only enriches its own new names). Universe keeps a sources[] array
    # (membership test); Master a single source text (exact match).
    src = getattr(args, "source", None)
    if src:
        q = q.contains("sources", [src]) if target == "universe" else q.eq("source", src)
    # Net-new only: rows created at/after the import. We never re-enrich names that
    # already existed in the DB (they're enriched on their own merit / rollout) —
    # only genuinely new names from this import. Universe marks new rows with
    # first_seen (a DATE); Master with created_at (timestamptz).
    since = getattr(args, "new_since", None)
    if since:
        # Floor to the DATE: import rows are created just before the import's
        # recorded timestamp, so an exact >= would miss them.
        col = "first_seen" if target == "universe" else "created_at"
        q = q.gte(col, since[:10])
    return q


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
    cat_raw = str(rec.get("category") or "").strip()
    cat = CATEGORY_BY_LOWER.get(cat_raw.lower(), FALLBACK_CATEGORY if cat_raw else None)
    con = str(rec.get("connotation") or "").strip().lower()
    return {
        "category": cat,
        "connotation": con if con in VALID_CONNOTATION else None,
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
            .select("domain, category, connotation, emotions, keywords, industries")
            .in_("domain", sub)
            .not_.is_("category", "null")
            .execute()
        )
        for r in resp.data or []:
            d = (r.get("domain") or "").lower()
            if d and r.get("category"):  # guard: only copy actually-enriched rows
                found[d] = {
                    "category": r.get("category"),
                    "connotation": r.get("connotation"),
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
    ap.add_argument("--concurrency", type=int, default=8, help="LLM calls in flight at once")
    ap.add_argument("--model", default=os.environ.get("ENRICHMENT_MODEL", DEFAULT_MODEL))
    ap.add_argument("--max-tokens", type=int, default=4000, help="output token ceiling per call")
    ap.add_argument("--order", choices=list(ORDERINGS), default=None,
                    help="row priority (default: universe=quality, master=domain)")
    ap.add_argument("--tld", default=None, help="restrict to a TLD (e.g. com)")
    ap.add_argument("--single-word", action="store_true", help="only one-word names")
    ap.add_argument("--dict-word", action="store_true", help="only dictionary-word names")
    ap.add_argument("--quality-min", type=float, default=None, help="quality_score >= (universe only)")
    ap.add_argument("--quality-max", type=float, default=None, help="quality_score < (universe only)")
    ap.add_argument("--source", default=None,
                    help="restrict to one source (universe sources[] membership / master source text)")
    ap.add_argument("--new-since", default=None,
                    help="net-new only: rows created at/after this ISO time "
                         "(universe first_seen date / master created_at)")
    ap.add_argument("--len-max", type=int, default=None, help="sld_length <=")
    ap.add_argument("--no-numbers", action="store_true", help="exclude names containing digits")
    ap.add_argument("--no-copy-overlap", action="store_true", help="skip the free cross-store copy step")
    ap.add_argument("--retry-failed", action="store_true",
                    help="revisit rows attempted before but still empty (enriched_at set, category null)")
    ap.add_argument("--reenrich", action="store_true",
                    help="re-do every row in scope, overwriting existing enrichment (ignores category)")
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

    order_key = args.order or DEFAULT_ORDER[args.target]
    order_col, order_asc = ORDERINGS[order_key][args.target]

    scope = ", ".join(filter(None, [
        f"tld={args.tld}" if args.tld else None,
        "single-word" if args.single_word else None,
        "dict-word" if args.dict_word else None,
    ])) or "all rows"

    model = args.model
    rate = RATES.get(model)
    conc = max(1, args.concurrency)
    print(f"enrich → {table} (model={model}, {'COMMIT' if args.commit else 'DRY-RUN'}, "
          f"max_rows={args.max_rows}, batch={args.batch}x{conc} workers, order={order_key} "
          f"[{order_col} {'asc' if order_asc else 'desc'}], scope: {scope})")

    anthropic_client = None
    if args.commit:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            print("enrich: ANTHROPIC_API_KEY not set — cannot --commit.")
            return 1
        from anthropic import Anthropic

        # generous retries so 429s under concurrency recover instead of dropping a batch
        anthropic_client = Anthropic(max_retries=8)

    processed = copied = llm_filled = failed = 0
    tot = {"in": 0, "out": 0, "cache_read": 0, "cache_write": 0}
    now = datetime.now(timezone.utc).isoformat()

    select_cols = ", ".join(PASSTHROUGH[args.target])
    while processed < args.max_rows:
        # Pull a whole window (concurrency × batch) and enrich its batches in
        # parallel, so throughput scales with workers instead of per-call latency.
        window = min(conc * args.batch, args.max_rows - processed)
        q = client.table(table).select(select_cols)
        if args.reenrich:
            # Re-do everything in scope once: select rows not yet touched THIS run
            # (enriched_at null or older than run start). As we stamp enriched_at=now
            # they drop out, so it terminates and never loops.
            q = q.or_(f"enriched_at.is.null,enriched_at.lt.{now}")
        else:
            q = q.is_("category", "null")
            q = q.not_.is_("enriched_at", "null") if args.retry_failed else q.is_("enriched_at", "null")
        q = _apply_scope(q, args.target, args)
        q = q.order(order_col, desc=not order_asc, nullsfirst=False).limit(window)
        rows = q.execute().data or []
        if not rows:
            break
        row_by_domain = {r["domain"]: r for r in rows}
        domains = list(row_by_domain)

        # 1) free cross-store copy for any overlap
        results: dict[str, dict] = {}
        if other_client is not None:
            overlap = _copy_overlap(other_client, other_table, domains)
            results.update(overlap)
            copied += len(overlap)

        todo = [d for d in domains if d not in results]
        if not args.commit:
            print(f"  [dry-run] window {len(domains)}: would enrich {len(todo)} via LLM "
                  f"(+{len(domains) - len(todo)} copied free) across {conc} workers: {todo[:3]}…")
            break  # one sample window is enough to preview cost/shape

        # 2) LLM the remainder — batches run concurrently
        chunks = [todo[i:i + args.batch] for i in range(0, len(todo), args.batch)]
        if chunks:
            with ThreadPoolExecutor(max_workers=conc) as pool:
                futs = [pool.submit(_enrich_batch, anthropic_client, model, c, args.max_tokens)
                        for c in chunks]
                for fut in as_completed(futs):
                    by_domain, usage = fut.result()
                    for k in tot:
                        tot[k] += usage[k]
                    results.update(by_domain)
            for d in todo:
                results.setdefault(d, {"category": None, "connotation": None,
                                       "emotions": [], "keywords": [], "industries": []})
            llm_filled += sum(1 for d in todo if results[d].get("category"))
            failed += sum(1 for d in todo if not results[d].get("category"))

        # 3) write — echo back NOT-NULL identity columns; upsert in sub-chunks
        payload = []
        for d in domains:
            rec = results.get(d) or {}
            item = {c: row_by_domain[d][c] for c in PASSTHROUGH[args.target]}
            item.update({
                "category": rec.get("category"),
                "connotation": rec.get("connotation"),
                "emotions": rec.get("emotions") or [],
                "keywords": rec.get("keywords") or [],
                "industries": rec.get("industries") or [],
                "enriched_at": now,
                "enrichment_model": model,
            })
            payload.append(item)
        for i in range(0, len(payload), 500):
            client.table(table).upsert(payload[i:i + 500], on_conflict="domain").execute()

        processed += len(domains)
        print(f"  processed {processed:,} (copied {copied:,}, llm {llm_filled:,}, "
              f"empty {failed:,})", flush=True)

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
