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
- Cloudflare-protected endpoints that need scrape.do (Oxley, NameJet,
  Dropcatch)
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
- **LLM enrichment** (`category` text, `connotation` text — 5-point: `positive`/
  `somewhat positive`/`neutral`/`somewhat negative`/`negative`, `emotions[]`,
  `keywords[]`, `industries[]` arrays) is a separate paid pass run by
  `pipeline enrich --target universe|master`
  (tool: `tools/enrich.py`; workflow: `.github/workflows/enrich-domains.yml`).
  Dry-run by default; `--commit` to write. Selection is
  `category IS NULL AND enriched_at IS NULL`, so legacy-enriched rows are never
  re-charged and attempted rows are stamped `enriched_at` (resumable, failure-safe;
  `--retry-failed` revisits empties). Before paying it copies any already-enriched
  row from the OTHER corpus on a domain match (free; becomes one-project SQL once
  Master is consolidated in). Output casing matches the search filters: emotions
  Title-cased, keywords/industries lowercase. Default model
  `claude-haiku-4-5-20251001` (override via `--model` / `ENRICHMENT_MODEL`).
  Scope flags narrow the slice (`--tld com --single-word --dict-word`) and
  `--order` prioritizes (universe defaults to `quality_score` desc). Starting
  strategy: one-word dictionary `.com` first (`enrich --target universe --tld com
  --single-word --dict-word`).
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
