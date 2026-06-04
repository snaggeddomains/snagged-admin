#!/usr/bin/env python3
"""Parse an ICANN CZDS zone file (.com / .co / …) into a CSV of
   domain,tld,nameservers  ready for bulk \\copy into Supabase (zone_domains).

A zone master file lists one NS record per line, sorted by domain, e.g.:

    EXAMPLE.COM.\t900\tin\tns\tNS1.EXAMPLE.NET.
    EXAMPLE.COM.\t900\tin\tns\tNS2.EXAMPLE.NET.

We group the consecutive NS lines per domain (O(1) memory — the zone is sorted)
into one row with the full nameserver set, emitting the Postgres array literal
"{ns1,ns2}". Non-NS records (A/DS/etc.) are skipped.

Usage:
    python3 scripts/zone_to_csv.py --zone /path/com.txt[.gz] --tld com --out com_ns.csv

Then load it (see scripts/zone_domains.sql for the table; build indexes AFTER):
    psql "$NAMING_PG_URL" -f scripts/zone_domains.sql
    psql "$NAMING_PG_URL" -c "\\copy zone_domains(domain,tld,nameservers) from 'com_ns.csv' with (format csv)"
    psql "$NAMING_PG_URL" -f scripts/zone_domains_indexes.sql
"""
from __future__ import annotations

import argparse
import csv
import gzip
import io
import sys


def _open(path: str):
    if path.endswith(".gz"):
        return io.TextIOWrapper(gzip.open(path, "rb"), encoding="utf-8", errors="replace")
    return open(path, "r", encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zone", required=True, help="path to the zone file (.txt or .gz)")
    ap.add_argument("--tld", required=True, help="tld these domains belong to, e.g. com")
    ap.add_argument("--out", required=True, help="output CSV path")
    args = ap.parse_args()
    tld = args.tld.lower().lstrip(".")

    cur = None          # current domain
    ns_set: set[str] = set()
    domains = 0

    with _open(args.zone) as f, open(args.out, "w", newline="") as out:
        w = csv.writer(out)

        def flush():
            nonlocal cur, ns_set, domains
            if cur and ns_set:
                w.writerow([cur, tld, "{" + ",".join(sorted(ns_set)) + "}"])
                domains += 1
            ns_set = set()

        for line in f:
            p = line.split()
            if len(p) < 4:
                continue
            # type token is p[3] ("NAME TTL IN NS HOST") or p[2] ("NAME IN NS HOST")
            if p[3].lower() == "ns" and len(p) >= 5:
                name, host = p[0], p[4]
            elif p[2].lower() == "ns" and len(p) >= 4:
                name, host = p[0], p[3]
            else:
                continue
            name = name.rstrip(".").lower()
            host = host.rstrip(".").lower()
            if not name or not host:
                continue
            if name != cur:
                flush()
                cur = name
            ns_set.add(host)
        flush()

    print(f"wrote {domains:,} domains → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
