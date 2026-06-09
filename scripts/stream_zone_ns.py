#!/usr/bin/env python3
"""Stream a zone file on stdin → CSV (domain,tld,nameservers) on stdout,
ready to pipe straight into  psql \\copy zone_domains(...) FROM STDIN.

Auto-detects the two source formats we ingest (sniffs the first data line,
then commits to one parser for the whole stream):

  1. Domains-Monitor "detailed" (semicolon, quoted) — .vc/.app/.ai/.co/.io:
       "domain";"ns1,ns2,…";"ip";"country";…      → one domain per line
  2. ICANN CZDS zone-master (whitespace NS records) — .com/.org/.net/.dev/.xyz:
       EXAMPLE.NET.  900  in  ns  NS1.EXAMPLE.NET.  → consecutive NS lines per
       domain (the zone is sorted, so we group with O(1) memory)

Only domain + nameserver set are kept (the pairing signal); everything else is
dropped on purpose. Hosts/domains are lowercased, de-dotted, de-duped, sorted;
template junk (ns1.{domain}) and the bare apex are skipped.

Usage:
    unzip -p net.zip | python3 scripts/stream_zone_ns.py net \
      | psql -v ON_ERROR_STOP=1 \
          -c "SET statement_timeout=0;" \
          -c "\\copy zone_domains(domain,tld,nameservers) FROM STDIN WITH (format csv)"
"""
from __future__ import annotations

import csv
import re
import sys

HOST = re.compile(r"^[a-z0-9._-]+$")  # reject template junk like ns1.{domain}


def _clean(host: str) -> str:
    return host.strip().rstrip(".").lower()


def _ns_array(hosts) -> str | None:
    ns = sorted({h for h in (_clean(x) for x in hosts) if h and "." in h and HOST.match(h)})
    return "{" + ",".join(ns) + "}" if ns else None


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: stream_zone_ns.py <tld>\n")
        return 2
    tld = sys.argv[1].strip().lstrip(".").lower()
    w = csv.writer(sys.stdout)
    n = 0

    # Buffer lines until we see the first non-blank one, to sniff the format.
    it = iter(sys.stdin)
    first = ""
    for line in it:
        if line.strip():
            first = line
            break
    if not first:
        sys.stderr.write("empty input\n")
        return 0

    semicolon = ";" in first and first.count(";") >= 1 and "\t" not in first[:200]

    def emit(domain: str, hosts) -> int:
        d = _clean(domain)
        if not d or d == tld or not HOST.match(d):
            return 0
        arr = _ns_array(hosts)
        if not arr:
            return 0
        w.writerow([d, tld, arr])
        return 1

    if semicolon:
        # Detailed: domain;ns_csv;...  — one domain per row, restart the reader
        # from `first` so we don't lose the sniffed line.
        reader = csv.reader(_prepend(first, it), delimiter=";", quotechar='"')
        for row in reader:
            if len(row) < 2:
                continue
            n += emit(row[0], row[1].split(","))
    else:
        # Zone-master: group consecutive NS records per domain.
        cur = None
        ns_set: set[str] = set()

        def flush():
            nonlocal cur, ns_set, n
            if cur and ns_set:
                n += emit(cur, ns_set)
            ns_set = set()

        for line in _prepend(first, it):
            p = line.split()
            if len(p) < 4:
                continue
            if p[3].lower() == "ns" and len(p) >= 5:      # NAME TTL IN NS HOST
                name, host = p[0], p[4]
            elif p[2].lower() == "ns" and len(p) >= 4:    # NAME IN NS HOST
                name, host = p[0], p[3]
            else:
                continue
            name = _clean(name)
            if name != cur:
                flush()
                cur = name
            ns_set.add(_clean(host))
        flush()

    sys.stderr.write(f"parsed {n:,} domains for .{tld} "
                     f"({'detailed/semicolon' if semicolon else 'zone-master'})\n")
    return 0


def _prepend(first, it):
    yield first
    yield from it


if __name__ == "__main__":
    raise SystemExit(main())
