#!/usr/bin/env python3
"""Read-only DB lookups against the Snagged Supabase projects.

Connection strings come from env — the least-privilege `claude_ro` role
(SELECT-only, BYPASSRLS so it still reads after RLS is enabled). Set these in
the Claude Code web environment config (Session-pooler / shared pooler URLs,
IPv4-friendly):

  RESEARCH_PG_RO_URL    main research project (domain_research_* tables)
  NAMING_PG_RO_URL      snagged-naming-universe (name_universe)
  MASTERLIST_PG_RO_URL  Master Domain Name List ("Master Domain List")

Usage:
  python3 scripts/db.py <project> "<sql>"
    <project> = research | naming | master

Examples:
  python3 scripts/db.py naming "select count(*) from name_universe where sources @> '{brandbucket}'"
  python3 scripts/db.py naming "select count(*) from name_universe where sources @> '{brandbucket}' and first_seen >= current_date"
  python3 scripts/db.py master  'select count(*) from "Master Domain List"'

Read-only by construction: the role has no INSERT/UPDATE/DELETE/DDL grants, and
the session is forced read-only. Don't put write SQL here — it will error.
"""
import os
import sys

ENV = {
    "research": "RESEARCH_PG_RO_URL",
    "naming": "NAMING_PG_RO_URL",
    "master": "MASTERLIST_PG_RO_URL",
}


def connect(url):
    try:
        import psycopg  # psycopg 3
        conn = psycopg.connect(url)
        try:
            conn.read_only = True
        except Exception:
            pass
        return conn
    except ImportError:
        pass
    try:
        import psycopg2
        conn = psycopg2.connect(url)
        conn.set_session(readonly=True)
        return conn
    except ImportError:
        sys.exit("Need a Postgres driver: pip install 'psycopg[binary]' (or psycopg2-binary)")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    proj, sql = sys.argv[1], sys.argv[2]
    var = ENV.get(proj)
    if not var:
        sys.exit(f"unknown project '{proj}' — use one of: {', '.join(ENV)}")
    url = os.environ.get(var)
    if not url:
        sys.exit(f"{var} not set in the environment (add it in the Claude Code web env config).")

    conn = connect(url)
    with conn, conn.cursor() as cur:
        cur.execute(sql)
        if cur.description:
            cols = [d[0] for d in cur.description]
            print("\t".join(cols))
            for row in cur.fetchall():
                print("\t".join("" if v is None else str(v) for v in row))
        else:
            print("(no rows returned)")


if __name__ == "__main__":
    main()
