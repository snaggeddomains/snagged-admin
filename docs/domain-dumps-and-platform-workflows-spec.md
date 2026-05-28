# Domain Dumps and Marketplace Workflows, Claude Build Spec

Last updated: 2026-05-28

This is the implementation-oriented version of the workflow doc. It is meant to help Claude or another coding agent formalize, refactor, or rebuild the current system without losing operational behavior.

## 1. Product surfaces to preserve

There are two primary output products.

### A. SNAP
Purpose:
- surface net-new or interesting marketplace listing opportunities

Destinations:
- Google Sheet: `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`
- Atom Wholesale sheet: `https://docs.google.com/spreadsheets/d/1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw/edit`
- Slack channel: `C09B1P21YQ0` (`#snap`)

Current producers:
- Afternic inventory diff
- Atom daily dump diff
- Namecheap BIN daily diff
- Atom Wholesale Google Doc ingest

### B. Auctions
Purpose:
- aggregate expiring / live auction names from multiple sources into one shortlist

Destinations:
- Google Sheet: `https://docs.google.com/spreadsheets/d/1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks/edit`
- Slack channel: `C096AT8BECS` (`#auctions`)

Current producers:
- Dynadot
- Namecheap auctions
- Drive auction uploads
- DropCatch
- Park.io
- GoDaddy
- NameSilo
- Sedo expired
- some NameJet-related sources exist in repo, but are disabled in the current main publish path

## 2. Current architecture in one sentence

The system is a file-based, source-by-source pipeline set where each source fetches raw input, normalizes/filter/scores it, writes JSON/CSV state into `data/`, then one or more publishers write Google Sheets and Slack summaries.

## 3. Main design constraints to preserve

Any rebuild should preserve these behaviors:

1. Partial source failure should not kill the entire auctions publish.
2. Shared SNAP sheets are multi-source and source-aware.
3. Net-new logic depends on previous local snapshots.
4. Some workflows append at top, some rebuild, some preserve non-owned rows.
5. Slack is a downstream notification layer, not the source of truth.
6. Schedulers are currently split between Linux cron and OpenClaw cron.
7. Some sources are dumps, some are docs, some are Drive uploads, some are scraper/API outputs.

## 4. Recommended target architecture

Claude should probably model this as 6 layers.

### Layer 1: source registry
Each source should be defined by config, not by hidden behavior in individual scripts.

Suggested registry fields:
- `source_id`
- `product` (`snap`, `auctions`, `aux`)
- `kind` (`csv_dump`, `drive_file`, `google_doc`, `scrape_json`, `api_export`)
- `schedule`
- `entrypoint`
- `input_artifacts`
- `output_artifacts`
- `normalizer`
- `filters_profile`
- `sheet_publishers`
- `slack_publisher`
- `ownership_mode`
- `failure_policy`
- `enabled`

### Layer 2: fetch
Responsible only for acquiring raw input.

Examples:
- download Afternic zip
- download Namecheap CSV
- scan Drive folder and download recent files
- read Google Doc body
- fetch JSON from scraper/API

### Layer 3: normalize
Convert each source into a standard internal schema.

Suggested normalized schemas:
- `MarketListing`
- `AuctionListing`
- `IngestRun`
- `SourceStatus`

### Layer 4: filter and score
Apply shared domain rules and per-source scoring.

### Layer 5: diff and state
Compute:
- new domains
- removed domains
- price changes
- current ranked shortlist
- previous snapshot

### Layer 6: publish
Separate publishers for:
- Google Sheets
- Slack
- optional logs / metrics

## 5. Suggested normalized schemas

### 5.1 MarketListing
Used for SNAP-like listing feeds.

```json
{
  "source": "afternic",
  "domain": "example.com",
  "sld": "example",
  "tld": ".com",
  "price": 2495.0,
  "currency": "USD",
  "link": "https://...",
  "zipf_score": 5.7,
  "quality_score": 5.7,
  "deal_score": 0.0023,
  "fast_transfer": true,
  "report_date": "2026-05-28",
  "raw_source_file": "inventory_latest.csv",
  "metadata": {}
}
```

### 5.2 AuctionListing
Used for auctions board.

```json
{
  "source": "dynadot",
  "domain": "example.com",
  "platform": "Dynadot",
  "end_time_utc": "2026-05-28T15:30:00Z",
  "price": 125.0,
  "currency": "USD",
  "bid_count": 3,
  "link": "https://...",
  "source_file": "optional.csv",
  "metadata": {}
}
```

### 5.3 SourceStatus
Used heavily by auctions.

```json
{
  "source": "dynadot",
  "label": "Dynadot",
  "status": "ok",
  "detail": "",
  "generated_at": "2026-05-28T10:00:00Z"
}
```

### 5.4 SnapshotContract
Used for net-new diffing.

```json
{
  "source": "afternic",
  "generated_at": "2026-05-28T10:00:00Z",
  "report_date": "2026-05-28",
  "items": []
}
```

## 6. Shared domain filtering contract

Current shared filtering is effectively:
- allowed TLDs: `.com`, `.org`, `.net`, `.io`, `.ai`, `.co`
- clean-word preference via `word_rules.py`
- default min zipf `2.8`
- `.io` min zipf `3.8`
- `.net` min zipf `5.5`
- 3-letter `.com` names are allowed

Current code location:
- `scripts/domain_filters.py`

Claude should centralize this into one reusable policy module and make each source explicitly declare whether it uses:
- standard listing filters
- auction filters
- upload filters
- custom source filter profile

## 7. Scheduling registry, current reality

The current system uses two schedulers.

### Linux cron
- `5:15 AM ET` Afternic diff wrapper
- `6:00 AM ET` Auctions publish
- `6:35 AM ET` Auctions watchdog
- every 10 minutes `6:00 AM` to `10:59 AM ET` Atom daily dump folder check
- `7:05 AM ET` refresh sublist sheet
- `6:00 AM`, `1:00 PM`, `7:00 PM ET` Sedo net-new
- `5:00 PM ET` Efty partner daily

### OpenClaw cron
- `5:25 AM ET` Namecheap daily BIN diff
- `9:35 AM ET` Atom dump retention
- `10:05 AM ET` Atom Wholesale doc refresh

Recommended rebuild direction:
- define one canonical scheduler registry in config
- optionally still execute through different backends, but stop hard-coding schedule truth in multiple places

## 8. Source contracts, one by one

## 8.1 Afternic

### Role
SNAP producer

### Raw source
- compressed inventory export downloaded by `scripts/run_afternic_diff.sh`

### Current entrypoints
- `scripts/run_afternic_diff.sh`
- `scripts/afternic_diff.py`
- `scripts/update_afternic_net_new_sheet.py`
- `scripts/refresh_sublist_sheet.py`

### Inputs
- remote zip export

### Local artifacts
- `data/afternic/inventory_latest.zip`
- `data/afternic/inventory_latest.csv`
- `data/afternic_top_250.json`
- `data/afternic_top_250.prev.json`
- `data/afternic_top_candidates.json`
- `data/afternic_diff.json`
- `data/afternic_sublist_latest.json`
- `data/afternic_net_new.json`

### Processing contract
1. Fetch latest inventory
2. Ensure file rolled for today
3. Parse CSV
4. Filter to allowed domains
5. Score quality and deal
6. Build ranked shortlist from top-by-quality and top-by-deal
7. Diff against previous shortlist
8. Save artifacts
9. Publish to sheet and Slack

### Publishing contract
Sheet:
- `Running Good Deals`
- `Today's New Listings`

Slack:
- `#snap`

### Ownership behavior to preserve
- Afternic logic owns Afternic rows
- non-Afternic rows in `Running Good Deals` are preserved during rebuild

### Rebuild recommendation
Make Afternic one source module with:
- fetcher
- normalizer
- scorer
- snapshot writer
- one source-aware sheet publisher

## 8.2 Atom daily dump

### Role
SNAP producer

### Raw source
- Google Drive folder `Atom Dumps`
- folder id: `1FFB8_8aTii5YQJheIQsJI0SqYRmFMg_4`

### Current entrypoints
- `scripts/process_daily_atom_folder.py`
- `scripts/atom_diff.py`
- `scripts/atom_drive_retention.py`

### Inputs
- daily file named like `M-D-YY Atom Dump.csv`

### Local artifacts
- `data/atom_partner_YYYYMMDD.csv`
- `data/atom_folder_ingest_state.json`
- `data/atom_diff.json`
- `data/atom_drive_retention_state.json`

### Processing contract
1. Look for today’s dump in Drive
2. Skip if already processed
3. Download into local `data/`
4. Compare newest dump with prior dump
5. Filter and score listings
6. Write net-new rows into SNAP sheet
7. Optionally run follow-on overlap jobs
8. Post Slack only when there are fresh rows

### Publishing contract
Sheet:
- `Today's New Listings`
- `Running Good Deals`

Slack:
- `#snap`

### Ownership behavior to preserve
- source label is `Atom`
- `Today's New Listings` should replace only Atom-owned rows for the report date
- `Running Good Deals` should append only domains not already present

### Retention behavior to preserve
- live folder keep 14 days
- archive keep 30 days

## 8.3 Atom Wholesale doc

### Role
SNAP producer, but with its own dedicated sheet

### Raw source
- Google Doc id `1-n-fiAOfTf9e5NaVSHCdgyNRTKdPuPBRx2A9XqwzczU`

### Current entrypoint
- `scripts/process_atom_wholesale_doc.py`

### Inputs
- unstructured Google Doc paragraphs

### Local artifacts
- minimal local state, mostly direct read/write

### Processing contract
1. Read document paragraphs
2. Parse domain + price + notes blocks
3. Determine net-new domains by checking existing sheet column A
4. Score listings
5. Insert new rows at top of sheet
6. Slack all new rows with SNAP markers for qualifying ones

### Publishing contract
Sheet:
- spreadsheet `1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw`
- tab `Running`

Slack:
- `#snap`

### Ownership behavior to preserve
- insert new rows at top, directly under header
- do not append to bottom

### Rebuild note
This should probably be modeled as a parser source with `kind=google_doc_tableish_text` rather than treated like a classic CSV dump.

## 8.4 Namecheap daily BIN diff

### Role
SNAP producer

### Raw source
- `https://d3ry1h4w5036x1.cloudfront.net/reports/Namecheap_Market_Sales_Buy_Now.csv`

### Current entrypoint
- `scripts/namecheap_daily_diff.py`

### Local artifacts
- `data/namecheap_buy_now_daily.csv`
- `data/namecheap_buy_now_daily.prev.csv`
- `data/namecheap_top_250.json`
- `data/namecheap_top_250.prev.json`
- `data/namecheap_top_candidates.json`
- `data/namecheap_diff.json`
- `data/namecheap_sublist_latest.json`
- `.state/namecheap_slack_post.json`

### Processing contract
1. Download CSV
2. Roll current to previous
3. Parse and filter
4. Score and rank
5. Diff vs previous shortlist
6. Replace Namecheap-owned fresh rows in SNAP sheet
7. Slack update with counts and top names
8. Avoid duplicate Slack via fingerprint state

### Publishing contract
Sheet:
- `Today's New Listings`

Slack:
- `#snap`

### Ownership behavior to preserve
- preserve other sources already in `Today's New Listings`
- replace only Namecheap source rows for current date

## 8.5 Auctions orchestration

### Role
Primary auctions product orchestrator

### Current entrypoints
- `scripts/publish_auction_shortlist.sh`
- `scripts/push_auctions_to_sheet.py`
- `scripts/post_auction_watchlist.py`
- `scripts/check_auction_publish.sh`

### Current contract
1. Initialize per-source statuses
2. Refresh each source independently
3. Mark each as `ok`, `failed`, or `disabled`
4. Continue even if some sources fail
5. Push consolidated rows to Google Sheet
6. Publish Slack summary from surviving sources
7. Watchdog retries if success marker missing

### Must-preserve behavior
- partial failure tolerance
- per-source status file
- skip stale/failed sources in publishers

## 8.6 Dynadot

### Role
Auctions producer

### Current entrypoints
- `scripts/dynadot_open_fetch.py`
- `scripts/dynadot_filter.py`

### Local artifacts
- `/tmp/dynadot_open.json`
- `dynadot_filtered.csv`

### Contract
1. Fetch raw open auctions JSON
2. Filter through shared domain rules
3. Publish filtered CSV for downstream consumers

## 8.7 Namecheap auctions

### Role
Auctions producer

### Current entrypoint
- `scripts/namecheap_auctions_crawl.py`

### Local artifacts
- `namecheap_auctions_latest.json`

### Contract
1. Download source CSV / marketplace auction feed
2. Filter by allowed domain rules and time horizon
3. Save normalized-ish JSON
4. Downstream sheet/slack parsers consume it

## 8.8 Drive auction uploads

### Role
Auctions producer and replacement path for some NameJet-related sources

### Current entrypoint
- `scripts/scan_drive_auction_uploads.py`

### Raw source
- Google Drive folder id `1vCnJb4iJeVJnLiRk4BwO7TEbRY16-Gta`

### Local artifacts
- `data/drive_uploads/raw/*`
- `data/drive_uploads_filtered.json`

### Contract
1. Scan recent files within 36-hour window
2. Download CSV/XLSX uploads
3. Detect format
4. Parse either NameJet-like or generic schema
5. Filter to allowed domains
6. Deduplicate by domain
7. Save structured output

### Must-preserve nuance
- even if not shown as a dedicated Slack section, this source is operationally important
- current system uses it as substitute for some older NameJet ingestion paths

## 8.9 DropCatch

### Role
Auctions producer

### Artifact
- `dropcatch_auctions_latest.json`

## 8.10 Park.io

### Role
Auctions producer

### Artifact
- `parkio_auctions_latest.json`

## 8.11 GoDaddy

### Role
Auctions producer

### Artifact
- `data/godaddy_auctions_filtered.json`

## 8.12 NameSilo

### Role
Auctions producer

### Artifact
- `data/namesilo_auctions_filtered.json`

## 8.13 Sedo expired

### Role
Auctions producer

### Artifact
- `data/sedo_expired_auctions.json`

## 8.14 Sedo net-new

### Role
Auxiliary feed, separate from main auctions board

### Current entrypoint
- `scripts/run_sedo_net_new.sh`

### Contract
1. export fresh Sedo search result set
2. post separate Slack update

## 8.15 NameJet sources

### Important current truth
Repo contains many NameJet scripts, but the main auction orchestrator currently disables:
- last chance
- email digest
- exclusive storefront

Instead, main publish writes empty placeholders and marks them disabled because Judy Drive dump handling is being used instead.

Claude should not assume those older NameJet paths are still active in production.

## 9. Current sheet contracts

## 9.1 SNAP sheet
Sheet:
- `1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8`

Tabs:
- `Running Good Deals`
- `Today's New Listings`

Observed behaviors:
- shared destination, multi-producer
- source ownership is implicit, not centralized
- some publishers rebuild entire source slice
- some append only net-new rows
- some preserve non-owned rows

### Refactor recommendation
Create a source-aware sheet writer abstraction with explicit modes:
- `replace_source_rows`
- `prepend_new_rows`
- `append_if_missing`
- `rebuild_owned_slice_preserve_foreign_rows`

## 9.2 Atom Wholesale sheet
Sheet:
- `1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw`

Tab:
- `Running`

Observed behavior:
- top insertion under header
- strong recency ordering expectation

## 9.3 Auctions sheet
Sheet:
- `1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks`

Range:
- `Sheet1!A2:E`

Observed behavior:
- writer prepends current rows ahead of existing rows, then rewrites range
- acts like rolling board/history, not clean snapshot only

## 10. Current Slack contracts

## 10.1 SNAP Slack
Channel:
- `C09B1P21YQ0`

Pattern:
- per-source posts
- includes sheet links
- usually top names, sometimes all new rows for Atom Wholesale

## 10.2 Auctions Slack
Channel:
- `C096AT8BECS`

Pattern:
- one consolidated post
- source-section layout
- failed/disabled sources omitted or annotated
- Drive Uploads intentionally not shown as its own section right now

## 11. State and idempotency contracts

### Current state style
Mostly flat files in `data/` and `.state/`.

Important state categories:
- previous shortlist snapshots
- diff results
- source refresh status
- ingest state for Drive sources
- dedupe/fingerprint state for Slack

### Refactor recommendation
Use one standard location pattern, for example:
- `state/<source_id>/snapshot_current.json`
- `state/<source_id>/snapshot_previous.json`
- `state/<source_id>/diff.json`
- `state/<source_id>/run_status.json`
- `state/<source_id>/publish_state.json`

## 12. Failure handling rules Claude should preserve

### Auctions
- one source failure should not abort entire publish
- failed sources should be marked and skipped downstream
- watchdog should retry if no publish success marker exists

### SNAP
- if source input is stale or missing, do not publish fake freshness
- avoid duplicate Slack posts when possible
- preserve non-owned rows in shared sheets

## 13. Biggest hidden complexities

These are the parts a rewrite could easily break.

1. Shared sheet row ownership is implicit and inconsistent.
2. Some scripts write source slices, others append rows, others rebuild tabs.
3. NameJet has many scripts in repo but not all are active in production.
4. Drive uploads are acting as a replacement ingestion channel for some auction content.
5. Current “truth” for schedules is fragmented.
6. Some flows rely on exact sheet behavior like top insertion.

## 14. Best rebuild path

If Claude is going to help code this up, the safest path is:

### Phase 1
Document and centralize source registry only.

### Phase 2
Standardize schemas and artifact paths.

### Phase 3
Wrap existing scripts behind adapters so outputs are normalized without immediately rewriting business logic.

### Phase 4
Replace per-source custom publishers with shared sheet/slack publisher modules.

### Phase 5
Unify scheduling and observability.

## 15. Immediate engineering tasks Claude could take on

1. Build `sources.yaml` or `sources.json` registry.
2. Build common Python models for `MarketListing`, `AuctionListing`, `SourceStatus`.
3. Build a shared Google Sheets publisher with explicit ownership modes.
4. Build a shared Slack formatter/publisher layer.
5. Move state files into a predictable per-source directory structure.
6. Add a command that prints current source health and last successful run.
7. Add tests for source diffing and row ownership preservation.

## 16. Canonical current entrypoints

### SNAP
- `scripts/run_afternic_diff.sh`
- `scripts/refresh_sublist_sheet.py`
- `scripts/process_daily_atom_folder.py`
- `scripts/atom_diff.py`
- `scripts/process_atom_wholesale_doc.py`
- `scripts/namecheap_daily_diff.py`

### Auctions
- `scripts/publish_auction_shortlist.sh`
- `scripts/push_auctions_to_sheet.py`
- `scripts/post_auction_watchlist.py`
- `scripts/check_auction_publish.sh`
- `scripts/scan_drive_auction_uploads.py`
- `scripts/namecheap_auctions_crawl.py`
- `scripts/dynadot_filter.py`

## 17. Short version for Claude

If you are rebuilding this, think of it as:

- a **source registry**
- feeding two major products, **SNAP** and **Auctions**
- with **file-based snapshots/diffs** as the current state backbone
- and **Google Sheets + Slack** as downstream publishers
- where the hardest part is not parsing dumps, but preserving the current row ownership, net-new logic, and partial-failure behavior
