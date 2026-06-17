# Marketplace per-domain Deal report — engagement, pitch-type, exercise pitches (2026-06-17)

The Reports → Marketplace → `[domain]` deal report (`dashboard/lib/marketplace-deals.ts`
`buildDealReport`, UI `app/reports/marketplace/[domain]/deal-client.tsx`, API
`app/api/admin/marketplace/deals/route.ts`) is reconstructed from the Gmail deal mailboxes
(`lib/gmail.ts`). Cached in Supabase `marketplace_deal_reports` for 6h (Regenerate forces a
rebuild). Enhancements this session:

- **Real back-and-forth vs form-and-gone.** Each thread now carries `repliedAfterUs` (a buyer
  message dated after our FIRST reply — a true two-way exchange, not just a submitted lead
  form). Report adds `inboundEngaged` = qualified inbound that replied after we did. UI: a
  **All / Responded-after-our-reply** toggle on the inbound table + a "Responded after we did"
  headline card. (`active` stays the recency-gated live-negotiation flag; engaged is all-time.)
- **Broker suppression.** `BROKER_DOMAINS = godaddy.com, afternic.com` fold into `isSystem` —
  GoDaddy/Afternic brokers (e.g. Jason Villalobos, afternicsales@godaddy.com) never count as a
  buyer counterparty. A real buyer they FORWARD still surfaces (form / forwarded headers); a
  broker-only thread is dropped.
- **Cold mass vs individual pitch — now HubSpot-authoritative (2026-06-17).** Pitch type is
  classified from the **HubSpot CRM email log** (`lib/hubspot.ts`, private-app token
  `HUBSPOT_TOKEN`; scopes `sales-email-read` + `automation.sequences.read` + `content`). The
  join key is the **RFC Message-ID**: HubSpot stores it as `hs_email_message_id`, which equals
  our `GmailMessage.mid` — so `classifyMessageIds(mids)` maps each of our sends to its logged
  engagement. An outbound send carrying an `hs_sequence_id` is a **sequence (mass)** send (its
  name resolved via `/automation/v4/sequences?userId=`, self-discovered from the token); a
  logged 1:1 is **individual**; `INCOMING_EMAIL` is inbound. The old Gmail `looksBulk()` header
  heuristic remains the **fallback** for sends not in the HubSpot log. `DealThread` carries
  `pitchKind` + `sequenceName` + per-thread `opens/clicks/replies`; report carries
  `pitchSource: "hubspot" | "heuristic"` (also the cache marker).
- **Three-bucket report (2026-06-17).** The drill-down is split into **1 · Inbound** (form /
  buyer-initiated, Gmail), **2 · Pitched 1:1** (individual outreach + naming-exercise sheet
  pitches), and **3 · Cold outreach (HubSpot sequences)**. Each bucket leads with its own metric
  cards and a responded/no-response toggle. Buckets 2 & 3 show HubSpot engagement (opens/clicks/
  replies). The cold bucket is the **FULL HubSpot sequence audience** (every recipient of a
  sequence naming the domain, not just threads in the deal mailboxes) via
  `recipientEngagementForDomain(domain)` (`hs_email_subject CONTAINS_TOKEN domain` + literal
  guard, aggregated per `hs_email_to_email` → sends/opens/clicks/replies + name + sequence);
  rows are enriched with the matching deal-mailbox thread's outcome/active when a cold send
  became a real exchange (`buildCold` in marketplace-deals.ts). `DealReport.cold: ColdOutreach`.
  Mass pitched-Gmail-threads are NOT shown in bucket 2 (they live in bucket 3) when HubSpot is
  on; without HubSpot, bucket 2 shows all pitched threads with a Mass/1:1 chip.
- **Unique-people metrics + chain drill-down (2026-06-17).** Every bucket's Opened / Clicked /
  Responded headline counts **unique individuals**, never a sum of reply emails (one recipient
  who generated a 100-email back-and-forth still counts as ONE responder). The "Responded" metric
  card is **clickable** → flips the bucket's toggle to the responded breakdown. Each cold roster
  row carries `chain` (the real conversation length — the matching deal-mailbox thread's message
  count, else the # of sequence steps the recipient replied to), shown as "💬 N in chain"; the
  pitched-1:1 rows show the chain as "· N msg". `ColdOutreach` adds a `responded` aggregate.
- **Pitch-scan sharpening (`lib/pitch-scan.ts`).** The weekly scan drops sent messages HubSpot
  logged as `INCOMING_EMAIL` (buyer replies mis-filed in Sent) and annotates confirmed cold
  sequence sends with their sequence name in the digest.
- **Naming-exercise pitches (Google Sheets).** `lib/marketplace-pitch-sheets.ts` reads the
  per-client pitch-exercise workbooks (where we pitch a client a curated domain shortlist) via
  the SAME service account (`marketplace-pipeline@snagged-pipeline...`, plain SA token — NO
  impersonation; delegation is NOT authorized for the Sheets scope, so the sheets must be
  link-shared or shared to the SA email). **Small explicit registry** `EXERCISES` (sheet id →
  client); **exact-domain** match across every tab (tolerant of header/headerless tabs + an
  SLD/TLD split tab). A hit = a pitch of that domain to that client → `DealReport.pitchExercises`,
  counted in bucket 2 (Pitched 1:1) + its own sub-table. Add an engagement = add one line to
  `EXERCISES`. `lib/sheets.ts` gained `getSheetMeta` (title + tab list).
- **Cache schema marker:** `readCache` ignores reports cached before the HubSpot wiring existed
  (`pitchSource === undefined`; prior marker was `inboundEngaged`) so old rows rebuild instead
  of serving the old Gmail-heuristic classification.

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

# Reports → Site Analytics: X Ads tranche (2026-06-08)

The **Ads** tab in Reports → Site Analytics (`dashboard/app/reports/analytics-client.tsx`
→ `AdsView`) is an X (Twitter) ad-spend + ROI tranche. X is Snagged's #1 self-reported
lead source (~41%), so the headline is **cost-per-X-lead = X spend ÷ X-attributed leads**.

- **`dashboard/lib/xads.ts`** — hand-rolled **OAuth 1.0a** signer (HMAC-SHA1 via Node
  `crypto`, no dependency — same dependency-free spirit as `lib/google-auth.ts`) + the
  `xAdsReport(from, to)` builder. Returns `totals` (spend/impressions/clicks/engagements
  + CPC/CPM/CTR), `byCampaign[]`, a daily `trend[]`, and `roi` (X-attributed leads,
  total leads, cost-per-lead). **Spend = `billed_charge_local_micro` / 1e6** (USD).
  ROI leads come from `analyticsReport("core")` `selfReportedSource` where the label is
  `X / Twitter` (tolerates `Twitter`/`X` free-text variants); null when GA isn't configured.
- **Live API constraints** (confirmed by probe 2026-06-08, app 33036944, Standard access):
  base `https://ads-api.x.com/12`; **DAY granularity is capped at a 7-day (+1h) window per
  call** and **≤20 entity_ids per call**, and day boundaries must be **midnight in the
  account's tz (America/New_York)**, not UTC — so `xAdsReport` chunks the date range into
  ≤7-day sub-windows × ≤20-id campaign groups and fetches them in parallel. Stats come back
  as **per-day arrays** under `data[].id_data[].metrics`, or `null` when an entity had no
  activity in the window.
- **Env (Vercel + web session):** `X_ADS_CONSUMER_KEY` / `X_ADS_CONSUMER_SECRET` (app
  key/secret) · `X_ADS_ACCESS_TOKEN` / `X_ADS_ACCESS_TOKEN_SECRET` (account token) ·
  `X_ADS_ACCOUNT_ID` (e.g. `18ce55lp5d7`). Account currency USD.
- **Wiring:** `ads` tranche in `app/api/admin/analytics/route.ts` (gated by the existing
  `reports.analytics` — **no new permission**); `x_ads` tool in `lib/chat-analytics.ts` so
  Chat Analytics can answer "what's our cost per lead on X this month?".
- **Local cache (speed / 429 / timeout fix):** X spend per campaign per day is append-only
  history, so it's snapshotted to Supabase (`x_ads_daily`, admin project — SUPABASE_URL/
  SERVICE_ROLE_KEY, same project as the import log) by a cron and read back from the table
  instead of re-fetching live every page view. `lib/xads-store.ts` (read/upsert) ·
  `lib/xads.ts` `getDailyRows` (cache-first, **live API fallback when empty** — degrades
  gracefully before backfill) · `syncXAdsDaily(days)` · cron `/api/cron/x-ads-sync`
  (CRON_SECRET-gated, runs inline — no GH workflow needed; `?days=N` to backfill, default
  trailing 14). **One-time setup:** run `scripts/x_ads_cache.sql` in the admin project, then
  backfill once: `curl -H "Authorization: Bearer $CRON_SECRET" ".../api/cron/x-ads-sync?days=1200"`.
  Scheduled 3×/day in `vercel.json`. GA stays live (single fast query: ROI leads + the lift
  channel series). The lift view is also **lazy-loaded** as a separate `part=lift` request so
  its trailing-90-day compute never blocks (or times out) the main spend view.
- **Per-ad + per-campaign effectiveness (2026-06-08):** a lazy `part=effectiveness` request
  (`xAdsEffectiveness`) → engagement efficiency (CTR/CPC/CPE/eng-rate), **runtime** (days
  active) and **week-over-week CTR trend + Δ CTR degradation** (last vs first active week),
  per campaign and per ad. UI = the "Effectiveness" section in `AdsView` with a Per-campaign/
  Per-ad toggle + sparkline. Per-ad data is its own cache: **`x_ads_ad_daily`** (one row per
  (date, promoted-tweet); campaign + tweet-text labels denormalized in; SQL
  `scripts/x_ads_ads_cache.sql`), synced by the SAME cron alongside `x_ads_daily`
  (`syncXAdsAdsDaily`; cron `?level=campaign|ad|both`, default both). The sync resolves
  campaign→line_item→promoted_tweet and pulls `entity=PROMOTED_TWEET` stats (same DST-safe,
  fault-tolerant chunking). **Conversion** efficiency (cost-per-lead per ad) is still
  account-level via the lift model — it can't be split per-ad until the **X conversion pixel**
  fires (the `WEB_CONVERSION` metrics come back null today; getting the pixel/CAPI working
  server-side unlocks true per-ad cost-per-conversion).
- **Next (Rob's direction):** stand up the X **Conversion API (CAPI)** server-side on the
  contact-form handler (keyed by `twclid` / hashed email) → unblocks per-ad conversions.
  Google Ads to be added as a second spend source once live — the tranche/`AdsView` are
  provider-agnostic enough to grow.

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

**Flow (2026-06-03 — simplified for non-admins):** a visual "How to use" explainer
sits at the top; the page now uses the standard content width (`--maxw`), not a 940
column. Default flow → drop CSV / paste → source name (typeahead) → optional
auto-backfill + auto-enrich → Start. Then per-import "Past Imports" cards show the
funnel: **Inserted · Net-new · Quality q≥1 · Enriched X/Y** with a green ✓ / yellow ⏳ /
red ✗ (stalled >24h) dot. Re-enrich button re-dispatches; trash deletes the log row only.
**Re-enrich also RETRIES FAILED rows** (2026-06-09): the pipeline stamps `enriched_at` on
every attempted row (so it's never re-charged), but an attempt that returns NO category
leaves `category IS NULL, enriched_at IS NOT NULL` — which the resumable selection
(`category IS NULL AND enriched_at IS NULL`) then skips forever (an import freezes at e.g.
580/582). So Re-enrich now passes `retryFailed` → the route calls `clearFailedEnrichStamps`
(`lib/imports.ts`) to null those stamps (scoped to source + net-new) BEFORE dispatching, so
they re-qualify. (Auto-enrich on import does NOT retry-failed — only the manual button.)
The import-log `import_ts` is now always stamped (the client passes it to the `log` action;
the route falls back to `now()`) — it was NULL before, so net-new scoping leaned on `created_at`.

- **Master-only UI — there is NO corpus picker.** The tool always imports to the Master
  Domain List; `admin.imports` alone is the gate (Universe is no longer a separate
  permission or a UI choice — the decision was removed). The universe code path remains
  server-side (`route.ts` still accepts `target=universe`) but the UI never sends it.
  - `admin.imports.replace` — without it the **Mode toggle is hidden** (always Merge) and
    the explainer drops the Merge/Replace step. The API 403s the `finalize-replace` action.
- **Owner is REQUIRED on Master** (`domain` required · `owner` required · `price` optional;
  template header `domain,owner,price`). The import **blocks** if any row lacks an owner;
  **Preview** surfaces a "Missing owner (required)" warn-stat + a log line. (Universe stores
  no owner, so it's not enforced there.)
- **Auto-enrich now defaults ON** (auto-backfill already did).

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

# Permissions — granular per-tab admin (lib/permissions.ts)

Two-tier model (module + action) in `dashboard/lib/permissions.ts`, stored in the
`permissions` JSONB on `domain_research_users`. **Every Admin tab is its own
user-settable permission** (`ADMIN_TABS` is the single source of truth for the
sub-nav + each tab's gate): `admin.sources` · `admin.config` · `admin.schedule` ·
`admin.users.manage` (Users) · `admin.imports` (+ `admin.imports.replace`) ·
`admin.lessons.approve` (Lessons). The `admin` umbrella key (and the `is_admin`
flag) grants ALL tabs.
- `canAdmin(user, key)` = `is_admin || perms.admin || perms[key]`; `canEnterAdmin(user)`
  = umbrella or any one tab. The admin layout admits on `canEnterAdmin` and passes only
  the allowed tabs to `<Nav>`; the TopBar mirrors this on mobile; **each page also
  re-checks its own tab perm** (server-side). `/admin` (Sources) redirects to the
  user's first allowed tab if they lack `admin.sources`.
- `is_admin` is the **owner-only** break-glass superuser (auto-passes everything) —
  reserve it for the owner; grant everyone else granular tabs. Research-side perms are
  flat keys (`domain_owner`, …) via `storageKey`; the research SPA's Admin link checks
  `is_admin || permissions.admin`.
- **FORWARD RULE: every new module/tool gets its own granular, user-settable permission
  in MODULES/ACTIONS + CATALOG (+ ADMIN_TABS if it's an admin tab).** Never gate a new
  surface on `is_admin` or the coarse `admin` umbrella alone.

# Read-only DB lookups (claude_ro)

For troubleshooting / confirming functionality, a least-privilege Postgres role
`claude_ro` (SELECT-only + `BYPASSRLS`, so it still reads after RLS is on) exists
in all three projects. Query via `python3 scripts/db.py <research|naming|master>
"<sql>"`. The role can read everything but **cannot write** (no
INSERT/UPDATE/DELETE/DDL grants). Recreate/rotate: `alter role claude_ro with
login bypassrls password '…';` then `grant usage on schema public … ; grant
select on all tables in schema public …`.

**Primary transport — REST over HTTPS/443 (this is the web path; nothing else
works on the web).** Claude Code on the web egresses through an HTTP proxy that
allows **ports 80/443 only** — raw Postgres (5432/6543) never connects there, on
*any* network policy including "Full" (the dropdown gates HTTP *domains*, not TCP
ports), so the direct-pooler approach is a dead end for web sessions. Instead,
lookups go through a token-gated PostgREST RPC `claude_ro_query(q, token)`
(SECURITY DEFINER, owned by `claude_ro` → read-only by construction; the shared
token stops the *public* anon key reading through it; the query is wrapped as a
subquery so writes can't even parse). Setup SQL per project:
`scripts/claude_ro_rest.sql`. `db.py` uses REST whenever a project's three vars
are set in the Claude Code **web environment config** (NOT Vercel):
`{RESEARCH,NAMING,MASTERLIST}_SUPABASE_REST_URL` (https://&lt;ref&gt;.supabase.co),
`…_SUPABASE_ANON_KEY` (public anon key — gateway only), `…_SUPABASE_RO_TOKEN`
(the shared token from the SQL). Rotate the token:
`update public._claude_ro_auth set token = '…';`. **All three verified working
2026-06-02.** (Why a token-RPC and not a `role: claude_ro` JWT: these projects
use the **new asymmetric** Supabase JWT keys — no legacy HMAC secret to self-sign
with.)

**Fallback — direct Postgres (pooler) on 5432, local terminal only.** For a
local shell that *does* have raw 5432 egress, `db.py` falls back to
`RESEARCH_PG_RO_URL` / `NAMING_PG_RO_URL` / `MASTERLIST_PG_RO_URL` (shared
**Session pooler**) when the REST vars aren't set. These were **removed from the
web env config** (they never worked there — 5432 is unreachable) and remain only
as a documented local-terminal option.

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
