#!/usr/bin/env bash
# Load ONE TLD's domain→nameserver rows into the zone_domains table from a
# Domains-Monitor "detailed" export (semicolon-delimited, quoted):
#   "domain";"ns1,ns2,…";"ip";"country";"webserver";"emails";"phones";…
# We keep ONLY domain + nameservers (the pairing signal); everything else is
# intentionally dropped (see the scope decision — IP is shared-CDN noise,
# contacts mostly duplicate registry WHOIS).
#
# Usage:
#   bash load_ns.sh <tld> <path-to-file.(txt|zip|gz)>
# Connection comes from libpq env vars set in your shell:
#   export PGHOST=... PGPORT=5432 PGUSER=postgres.<ref> PGDATABASE=postgres PGPASSWORD=...
#
# Efficient multi-TLD workflow (avoids per-row GIN maintenance + repeated builds):
#   psql -c "drop index if exists idx_zone_domains_ns_gin;"     # once, before loading
#   bash load_ns.sh ai  "/path/ai/ai.txt"
#   bash load_ns.sh co  "/path/co.zip"
#   …one per TLD…
#   psql -c "SET statement_timeout=0;" -c "set maintenance_work_mem='256MB';" \
#        -c "create index idx_zone_domains_ns_gin on zone_domains using gin(nameservers);" \
#        -c "analyze zone_domains;"                              # once, after all loads
#
# Re-loading a TLD already present? Delete it first (PK is domain):
#   psql -c "delete from zone_domains where tld='ai';"
set -euo pipefail

TLD="${1:?usage: load_ns.sh <tld> <file>}"
FILE="${2:?usage: load_ns.sh <tld> <file>}"
TLD="$(printf '%s' "$TLD" | tr '[:upper:]' '[:lower:]' | sed 's/^\.//')"
[ -e "$FILE" ] || { echo "file not found: $FILE" >&2; exit 1; }

case "$FILE" in
  *.zip) READ=(unzip -p "$FILE") ;;
  *.gz)  READ=(gunzip -c "$FILE") ;;
  *)     READ=(cat "$FILE") ;;
esac

"${READ[@]}" | python3 -c '
import sys, csv, re
tld = sys.argv[1]
HOST = re.compile(r"^[a-z0-9._-]+$")   # reject template junk like ns1.{domain}
w = csv.writer(sys.stdout); n = 0
for row in csv.reader(sys.stdin, delimiter=";", quotechar=chr(34)):
    if len(row) < 2:
        continue
    d = row[0].strip().rstrip(".").lower()
    nsf = row[1].strip()
    if not d or not nsf or d == tld or not HOST.match(d):   # skip blanks, apex, junk
        continue
    ns = sorted({h for h in (x.strip().rstrip(".").lower() for x in nsf.split(",")) if h and "." in h and HOST.match(h)})
    if not ns:
        continue
    w.writerow([d, tld, "{" + ",".join(ns) + "}"]); n += 1
sys.stderr.write(f"parsed {n:,} domains for .{tld}\n")
' "$TLD" \
  | psql -v ON_ERROR_STOP=1 \
      -c "SET statement_timeout = 0;" \
      -c "\copy zone_domains(domain,tld,nameservers) FROM STDIN WITH (format csv)"
