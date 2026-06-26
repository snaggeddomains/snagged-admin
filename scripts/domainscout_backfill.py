#!/usr/bin/env python3
"""One-time backfill: add every historically-researched domain to DomainScout.

Reads the distinct domains from the Domain Owner research runs table (read-only,
via scripts/db.py) and POSTs each into the DomainScout watchlist so the existing
corpus is tracked alongside new research requests (which auto-track from now on).

Idempotent: re-tracking a domain DomainScout already monitors is a harmless no-op
(201 created / 200 ok / 409 / 422 all count as success). Rate-limited and
fail-soft per domain so one bad row never aborts the run.

Usage:
    DOMAINSCOUT_KEY=<token> python3 scripts/domainscout_backfill.py [--dry-run] [--delay 0.4]

The key is NOT read from a file or hardcoded — pass it in the environment. API
access requires the DomainScout Hunter plan (a lesser-plan token returns 403).
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "https://www.domainscout.io/api/v1/domains"
HERE = os.path.dirname(os.path.abspath(__file__))


def fetch_domains() -> list[str]:
    """Distinct researched domains, via the read-only db.py REST helper."""
    sql = (
        "select distinct lower(domain) as domain from domain_research_runs "
        "where domain is not null and domain <> '' order by 1"
    )
    out = subprocess.check_output(
        [sys.executable, os.path.join(HERE, "db.py"), "research", sql],
        text=True,
    )
    lines = [ln.strip() for ln in out.splitlines() if ln.strip()]
    # db.py prints a TSV with a header row ("domain"); drop it.
    rows = [ln for ln in lines if ln != "domain"]
    # Tolerate a multi-column TSV by taking the first field.
    return [ln.split("\t")[0].strip() for ln in rows]


def track(domain: str, key: str, timeout: int = 20) -> tuple[int, str]:
    body = ('{"domain": "%s"}' % domain).encode()
    req = urllib.request.Request(
        BASE,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            # DomainScout sits behind Cloudflare, which 403s the default
            # "Python-urllib/x" UA (error 1010). Send a normal UA.
            "User-Agent": "snagged-domainscout-backfill/1.0 (+https://snagged.com)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, ""
    except urllib.error.HTTPError as e:
        return e.code, (e.read(timeout) if False else e.reason) or ""
    except Exception as e:  # noqa: BLE001
        return 0, str(e)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="list domains, don't POST")
    ap.add_argument("--delay", type=float, default=0.4, help="seconds between POSTs")
    args = ap.parse_args()

    key = os.environ.get("DOMAINSCOUT_KEY") or os.environ.get("DOMAINSCOUT_API_KEY")
    if not key and not args.dry_run:
        print("ERROR: set DOMAINSCOUT_KEY in the environment", file=sys.stderr)
        return 2

    domains = fetch_domains()
    print(f"{len(domains)} distinct researched domains")
    if args.dry_run:
        for d in domains:
            print(d)
        return 0

    ok = already = failed = 0
    for i, d in enumerate(domains, 1):
        status, msg = track(d, key)
        if status in (200, 201):
            ok += 1
            tag = "tracked"
        elif status in (409, 422):
            already += 1
            tag = "already"
        else:
            failed += 1
            tag = f"FAIL {status} {msg}".strip()
        print(f"[{i}/{len(domains)}] {d} -> {tag}")
        if status == 403:
            print("403 — token needs the Hunter plan; aborting.", file=sys.stderr)
            return 3
        time.sleep(args.delay)

    print(f"\nDone: {ok} tracked, {already} already-tracked, {failed} failed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
