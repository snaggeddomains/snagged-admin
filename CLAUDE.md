# Working agreements

## Probes and one-shot scripts: run locally by default

When a task is a pure-compute probe or one-shot diagnostic that could be
done either by (a) pushing a GitHub Actions workflow + waiting for Rob to
dispatch and paste the log back, or (b) running directly in this sandbox
with `python3` / `requests` / etc. — **default to (b)**.

Only push an Actions workflow when the target genuinely requires a GH
runner:

- IP-allowlisted edges (Sedo's CDN returns `403 "Host not in allowlist"`
  to this sandbox; GH runners are on the allowlist)
- Cloudflare-protected endpoints that need scrape.do (Oxley, NameJet)
- Headless-browser scrapes that need Playwright + Chromium (Dropcatch renders
  dropcatch.com/auctions via Playwright — not scrape.do)
- Workflows that need GitHub Secrets we don't have locally
- Anything that should run on a recurring cron

For everything else — Sheets reads, Spaceship/Atom/Namecheap APIs,
Supabase queries, Drive ops, pipeline CLI commands — execute it here and
report the result. No round-trip, no dispatch link, no copy/paste.

# Domain data model — canonical (do not let this drift)

Two domain corpora live in **separate Supabase projects**. Keep the boundary clean:

**`name_universe`** — project `snagged-naming-universe` (env `SUPABASE_NAMING_URL` /
`SUPABASE_NAMING_SERVICE_KEY`). Home for **everything automated**: all SNAP/pipeline
sources + marketplace feeds (afternic, atom, sedo, namecheap_bin, oxley, efty, the
owned sheets — snagged_snap_sheet, rob_purchases_sheet, snagged_marketplace_sheet,
berserk_snap_sheet — and BrandBucket going forward). One row per `domain` with a
`sources[]` array and `source_tier` (1 = owned/controlled, 2 = broad market).
Written **only** by this pipeline (`universe/supabase_writer.py` →
`upsert_universe_rows` RPC).
- **TLD is stored BARE** (`com`, never `.com`). `merged_to_universe_row()` strips the
  dot; existing rows were backfilled 2026-06. Never write a leading dot.
- **Structural enrichment** (`zipf_score`, `num_words`, `num_syllables`,
  `is_dictionary_word`) is computed at ingest via `wordfreq`
  (`filters/universe.classify_dict_word`). `num_words`/`is_dictionary_word` are NULL
  for non-dictionary SLDs.
- **LLM enrichment** (`category` text — one of a **controlled ~31-label list**
  (`CATEGORIES` in `tools/enrich.py`; unknown → `General & Other`); `connotation`
  text — 5-point: `positive`/`somewhat positive`/`neutral`/`somewhat negative`/
  `negative`; `emotions[]`, `keywords[]`, `industries[]` arrays) is a separate paid
  pass run by `pipeline enrich --target universe|master`
  (tool: `tools/enrich.py`; workflow: `.github/workflows/enrich-domains.yml`).
  Dry-run by default; `--commit` to write. Selection is
  `category IS NULL AND enriched_at IS NULL`, so legacy-enriched rows are never
  re-charged and attempted rows are stamped `enriched_at` (resumable, failure-safe;
  `--retry-failed` revisits empties). Before paying it copies any already-enriched
  row from the OTHER corpus on a domain match (free; becomes one-project SQL once
  Master is consolidated in). Output casing matches the search filters: emotions
  Title-cased, keywords/industries lowercase. Default model
  `claude-haiku-4-5-20251001` (override via `--model` / `ENRICHMENT_MODEL`).
  Scope flags narrow the slice (`--tld com --single-word --dict-word
  --quality-min/--quality-max --len-max --no-numbers`) and `--order` prioritizes
  (universe defaults to `quality_score` desc). Starting strategy: one-word
  dictionary `.com` first (`enrich --target universe --tld com --single-word
  --dict-word`).
  `pipeline enrich-batch submit|collect|status` runs the same enrichment via the
  Anthropic Message Batches API (50% cheaper, async ≤24h; state in
  `state/enrichment/batches.jsonl`; tool `tools/enrich_batch.py`, workflow
  `.github/workflows/enrich-batch.yml`) — for the `quality_score`-banded bulk
  rollout. `submit` is dry-run unless `--commit`; `collect` upserts ended batches.
  **One-time setup SQL** (run in each project):
  ```sql
  -- name_universe (naming project)
  alter table name_universe add column if not exists connotation text;
  alter table name_universe add column if not exists enriched_at timestamptz;
  alter table name_universe add column if not exists enrichment_model text;
  create index if not exists idx_universe_enrich_queue on name_universe
    (num_words, is_dictionary_word, tld, quality_score desc nulls last)
    where category is null and enriched_at is null;
  -- Master Domain List (masterlist project)
  alter table "Master Domain List" add column if not exists industries text[];
  alter table "Master Domain List" add column if not exists connotation text;
  alter table "Master Domain List" add column if not exists enriched_at timestamptz;
  alter table "Master Domain List" add column if not exists enrichment_model text;
  create index if not exists idx_master_industries_gin
    on "Master Domain List" using gin (industries);
  create index if not exists idx_master_needs_enrich on "Master Domain List" (domain)
    where category is null and enriched_at is null;
  ```

**Master Domain List** — project `Master Domain Name List` (env
`MASTERLIST_SUPABASE_URL` / `MASTERLIST_SUPABASE_SECRET_KEY`). **Manual / curated
owner attributions only**: hand-uploaded CSV/portfolio imports + real-owner rows +
the broader `snagged` set. One row per `domain` with a single `source` text +
`owner`. NOT written by this pipeline.
- `is_single_word` / `dictionary_word` are TEXT `'Y'`/`'N'`; `emotions`/`keywords`
  are `text[]` (migrated 2026-06 to match Universe; Master emotions stored
  Capitalized — the search title-cases the emotion filter).
- **2026-06 cleanup:** removed ~3.75M marketplace placeholder dupes (sources
  sedo/afternic/atom where `owner` was null or a marketplace name
  Atom/Sedo/Afternic/Namecheap/BrandBucket). Real-owner rows kept. Backup in
  `master_domain_list_backup` (+ Pro PITR). ≈ 435K rows post-cleanup.

**Boundary rule:** automated/SNAP + marketplace feeds → `name_universe`;
manual/curated owner attributions → Master. BrandBucket is a marketplace feed → it
belongs in `name_universe` (don't enrich it in Master).

**Search (research app):** Domain Name Search (`api/dbsearch.js`) queries both
(`db=both|universe|master`); Domain DB Screen (`api/dbscreen.js`) is the
single-domain lookup. Universe filters use `num_words`/`is_dictionary_word`; Master
uses `is_single_word`/`dictionary_word`. TLD filters require a single-dot domain
(exclude multi-label hosts like `ab.co.com`).

# Admin Imports tool — app.snagged.com/admin/imports

Manual CSV/paste importer into either corpus. Code: `dashboard/app/admin/imports/*`
(client), `dashboard/app/api/admin/imports/route.ts` (actions), `dashboard/lib/imports.ts`
(DB). **Lives in the snagged-admin Vercel project**, so that project needs its OWN
env vars (separate from research): `SUPABASE_NAMING_*` (universe), `MASTERLIST_SUPABASE_*`
(master), and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (the MAIN research DB — it
backs user auth AND the import-history log; **not** the naming universe).

**Flow:** pick target (Universe vs Master) → drop CSV / paste → source name (typeahead)
→ Merge|Replace → optional auto-backfill + auto-enrich → Start. Then per-import "Past
Imports" cards show the funnel: **Inserted · Net-new · Quality q≥1 · Enriched X/Y** with
a green ✓ / yellow ⏳ / red ✗ (stalled >24h) dot. Re-enrich button re-dispatches; trash
deletes the log row only.

- **Upsert** is chunked client-side (universe 400/req, master 1000) and **halves on a
  statement timeout** (`57014`) server-side, so big files (145K+) land. Universe goes
  through the `upsert_universe_rows` merge RPC; master is a plain upsert (+`owner`,
  Master-only). Preview streams **domain strings** in 3,000-batches (`preview-existing`),
  and `countExisting` sub-chunks the `IN(...)` at 200 (URL-length cap).
- **Source typeahead** is target-aware: Universe = `sources.yaml` registry ids +
  `UNIVERSE_EXTRA_SOURCES` (brandbucket — a manual feed not in the registry) + names
  from the import log; Master = `distinct_master_sources()` RPC + log names.
- **Post-import backfill** = `backfill-universe-structural.yml` (universe; all 6
  structural fields) / `backfill-quality-master.yml` (master; quality_score only,
  `commit=true`).
- **Enrich = NET-NEW ONLY ∧ quality_score ≥ 1 ∧ un-enriched.** Never re-enrich names
  that already existed (a Merge just appends the source to their `sources[]`). Net-new
  via `--new-since <import_ts>`: universe `first_seen` (a DATE), master `created_at` —
  **floored to the date** (import rows are created just before the log entry, so an
  exact-timestamp `>=` would miss them). `--source` scopes to the import's source.
- **`pipeline enrich-batch auto --min-batch-saving 5`** is the chained enrich: counts
  eligible, estimates the 50%-off batch saving from `RATES`, and runs **realtime
  immediately** unless the saving clears $5 → then submits the async batch (collected by
  the 4h cron). Fail-safe: if the eligible count times out it returns -1 → submit async.
  `--source` / `--new-since` were added to `enrich` + `enrich-batch` + the `pipeline` CLI
  subparsers (cli.py builds its own argv — wire new flags in BOTH the tool and cli.py).

**Required one-time SQL:**
```sql
-- naming project (snagged-naming-universe) — CRITICAL: source-scoped count/enrich/status
-- seq-scan + time out (57014) without this.
create index concurrently if not exists idx_universe_sources_gin
  on name_universe using gin (sources);
-- masterlist project — powers the Master source typeahead
create or replace function distinct_master_sources()
returns table(source text) language sql stable as $$
  select distinct source from "Master Domain List"
  where source is not null and source <> '' order by source $$;
-- main research project — import-history log (migrations 0004 + 0005)
create table if not exists domain_research_imports ( ... );   -- 0004
alter table domain_research_imports add column if not exists import_ts timestamptz;  -- 0005
```
Validated 2026-06-02: Reflex (1,960→1,959 net-new→616 q≥1→616 enriched via batch),
brandbucket (145,722→5 net-new→0 q≥1→skipped), Narendra Ghimire (1,496→20→13→13 enriched
realtime). All three paths (batch / skip / realtime) confirmed.

# Read-only DB lookups (claude_ro)

For troubleshooting / confirming functionality, a least-privilege Postgres role
`claude_ro` (SELECT-only + `BYPASSRLS`, so it still reads after RLS is on) exists
in all three projects. Query via `python3 scripts/db.py <research|naming|master>
"<sql>"`. The role can read everything but **cannot write** (no
INSERT/UPDATE/DELETE/DDL grants). Recreate/rotate: `alter role claude_ro with
login bypassrls password '…';` then `grant usage on schema public … ; grant
select on all tables in schema public …`. `db.py` has **two transports** (same
UX); env vars are set in the Claude Code **web environment config** (NOT Vercel):

- **REST over HTTPS/443 (preferred — the ONLY thing that works on the web).**
  Claude Code on the web egresses through an HTTP proxy that allows **80/443
  only** — raw Postgres (5432/6543) never connects there, on any network policy
  including "Full" (the dropdown gates HTTP *domains*, not TCP ports). So web
  lookups go through a token-gated PostgREST RPC `claude_ro_query(q, token)`
  (SECURITY DEFINER, owned by `claude_ro` → read-only by construction; shared
  token stops the public anon key reading through it). Setup SQL per project:
  `scripts/claude_ro_rest.sql`. Env vars per project:
  `{RESEARCH,NAMING,MASTERLIST}_SUPABASE_REST_URL` (https://&lt;ref&gt;.supabase.co),
  `…_SUPABASE_ANON_KEY` (public anon key, gateway), `…_SUPABASE_RO_TOKEN` (the
  shared token from the SQL). `db.py` uses REST whenever these three are set.
  Rotate the token: `update public._claude_ro_auth set token = '…';`.
- **Direct Postgres (pooler) on 5432 — fallback for a local terminal** with raw
  egress. URLs (shared **Session pooler**, IPv4-friendly):
  `RESEARCH_PG_RO_URL` / `NAMING_PG_RO_URL` / `MASTERLIST_PG_RO_URL`; needs the
  env's network policy to allow `*.pooler.supabase.com:5432`. (Originally the
  only path; superseded by REST for web sessions, which can't reach 5432.)

NB: this project's Supabase JWT secret is the **new asymmetric** kind (no legacy
HMAC secret), so a custom-role JWT can't be self-minted — hence the token-gated
RPC instead of a `role: claude_ro` JWT.

# Security: enable RLS on Master + naming (no policies)

Supabase flagged the **Master** project (and naming is the same shape) for
`rls_disabled_in_public`. Our apps use the **service_role** key (bypasses RLS),
so enabling RLS with **no policies** closes anon/public access without breaking
anything (matches the main research project). Run per project:
`do $$ declare r record; begin for r in select tablename from pg_tables where
schemaname='public' loop execute format('alter table public.%I enable row level
security;', r.tablename); end loop; end $$;`

# Session handoff — 2026-06-02 (imports + notifications + permissions)

Shipped to `main` (both repos) this session:
- **Admin Imports tool** — full build (see section above): preview, owner column,
  net-new+quality auto-enrich (realtime <$5 / batch ≥$5), per-import funnel cards
  with green/yellow/red status + "view qualifying domains" drill-down, Re-enrich.
  Master is the default target.
- **Permissions** — new `admin.imports` (module) gates the import tool; new
  `admin.lessons.approve` (action) gates lesson curation. Both in
  `dashboard/lib/permissions.ts` CATALOG; research enforces `admin.lessons.approve`
  in `api/lessons.js` (was strict is_admin).
- **Notifications** — research `api/lessons.js` notifies curators (bell + email)
  when a lesson is submitted (`notifyAdminsOfLesson`, kind 'lesson'). The admin
  **top bar** now has the bell + profile avatar (`app/notifications-bell.tsx`,
  `app/top-bar.tsx`, `lib/notifications.ts`, `api/notifications/route.ts`) reading
  the shared `domain_research_notifications` table.

OPEN / next session:
1. **Run the GIN index** `idx_universe_sources_gin` on the naming project (CRITICAL
   for source-scoped enrich/count/status; without it they time out 57014).
2. **Run RLS-enable** on Master + naming (security alert above).
3. **Run migrations** 0004 + 0005 on the main research project (import-history log
   + `import_ts`).
4. **Verify read-only DB** once `*_PG_RO_URL` env vars are set: `python3
   scripts/db.py naming "select 1"`, then the brandbucket net-new split
   (`total` vs `first_seen>=current_date` vs `+ quality_score>=1`) to confirm the 0.
