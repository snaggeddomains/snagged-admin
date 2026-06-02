#!/usr/bin/env python3
"""Read-only DB lookups against the Snagged Supabase projects.

Two transports, same UX (`python3 scripts/db.py <project> "<sql>"`):

1. REST over HTTPS (port 443) — used automatically when the project's
   `*_SUPABASE_REST_URL` / `*_SUPABASE_ANON_KEY` / `*_SUPABASE_RO_TOKEN` env
   vars are set. This is the ONLY transport that works from Claude Code on the
   web, where egress is funneled through an HTTP proxy that allows 80/443 only
   (raw Postgres on 5432/6543 never connects). It POSTs to a read-only RPC
   (`claude_ro_query`) that runs as the SELECT-only `claude_ro` role (no write
   grants → read-only by construction) and is gated by the shared token.

2. Direct Postgres (port 5432) via the `claude_ro` session-pooler URL — used
   when the REST vars aren't set (e.g. a local terminal with 5432 egress). The
   `claude_ro` role is SELECT-only + BYPASSRLS, so it still reads after RLS is
   enabled.

Env vars (set in the Claude Code web environment config, NOT Vercel):

  REST transport (preferred):
    {RESEARCH,NAMING,MASTERLIST}_SUPABASE_REST_URL    https://<ref>.supabase.co
    {RESEARCH,NAMING,MASTERLIST}_SUPABASE_ANON_KEY    public anon key (gateway)
    {RESEARCH,NAMING,MASTERLIST}_SUPABASE_RO_TOKEN    shared read-only token

  Pooler transport (fallback):
    RESEARCH_PG_RO_URL / NAMING_PG_RO_URL / MASTERLIST_PG_RO_URL

Usage:
  python3 scripts/db.py <project> "<sql>"
    <project> = research | naming | master

Examples:
  python3 scripts/db.py naming "select count(*) from name_universe where sources @> '{brandbucket}'"
  python3 scripts/db.py naming "select count(*) from name_universe where sources @> '{brandbucket}' and first_seen >= current_date"
  python3 scripts/db.py master  'select count(*) from "Master Domain List"'

Read-only by construction on both transports: the `claude_ro` role has no
INSERT/UPDATE/DELETE/DDL grants, so write statements just error out.
"""
import json
import os
import sys
import urllib.error
import urllib.request

# Direct-Postgres (pooler) URLs — fallback transport.
PG_ENV = {
    "research": "RESEARCH_PG_RO_URL",
    "naming": "NAMING_PG_RO_URL",
    "master": "MASTERLIST_PG_RO_URL",
}

# REST (HTTPS) transport — (url, anon-key, token) env var names per project.
REST_ENV = {
    "research": ("RESEARCH_SUPABASE_REST_URL", "RESEARCH_SUPABASE_ANON_KEY", "RESEARCH_SUPABASE_RO_TOKEN"),
    "naming": ("NAMING_SUPABASE_REST_URL", "NAMING_SUPABASE_ANON_KEY", "NAMING_SUPABASE_RO_TOKEN"),
    "master": ("MASTERLIST_SUPABASE_REST_URL", "MASTERLIST_SUPABASE_ANON_KEY", "MASTERLIST_SUPABASE_RO_TOKEN"),
}


def _fmt(v):
    if v is None:
        return ""
    if isinstance(v, (list, dict, bool)):
        return json.dumps(v)
    return str(v)


def print_rows(rows):
    """rows = list of dicts (REST) — print header + tab-separated values."""
    if not rows:
        print("(0 rows)")
        return
    cols = list(rows[0].keys())
    print("\t".join(cols))
    for r in rows:
        print("\t".join(_fmt(r.get(c)) for c in cols))


def run_rest(base, anon, token, sql):
    url = base.rstrip("/") + "/rest/v1/rpc/claude_ro_query"
    body = json.dumps({"q": sql, "token": token}).encode()
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "apikey": anon,
            "Authorization": "Bearer " + anon,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            payload = resp.read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"REST error {e.code}: {e.read().decode()[:1000]}")
    except urllib.error.URLError as e:
        sys.exit(f"REST request failed: {e}")
    data = json.loads(payload) if payload.strip() else []
    if not isinstance(data, list):  # scalar return
        data = [{"result": data}]
    print_rows(data)


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


def run_pg(url, sql):
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


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    proj, sql = sys.argv[1], sys.argv[2]

    if proj not in PG_ENV:
        sys.exit(f"unknown project '{proj}' — use one of: {', '.join(PG_ENV)}")

    # Prefer REST (works over 443, the only egress allowed on the web) when configured.
    rest_vars = REST_ENV[proj]
    base, anon, token = (os.environ.get(v) for v in rest_vars)
    if base and anon and token:
        run_rest(base, anon, token, sql)
        return

    # Fall back to the direct-Postgres pooler URL.
    url = os.environ.get(PG_ENV[proj])
    if not url:
        sys.exit(
            f"No transport configured for '{proj}'. Set the REST vars "
            f"({', '.join(rest_vars)}) or the pooler URL ({PG_ENV[proj]})."
        )
    run_pg(url, sql)


if __name__ == "__main__":
    main()
