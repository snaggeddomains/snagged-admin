# Domain Dumps and Marketplace Workflows

Last updated: 2026-05-28

This document describes the current domain dump and marketplace workflows that are actually running from the OpenClaw workspace. It is written as an implementation-oriented overview so it can be handed to Claude or another coding agent to help formalize, refactor, or rebuild the system.

## 1) High-level overview

There are really two major downstream products here:

1. **SNAP / fresh-listing monitoring**
   - Goal: detect promising net-new BIN / listing opportunities from marketplace dumps.
   - Outputs:
     - Google Sheet for running/fresh listings:
       - `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`
     - Atom Wholesale running sheet:
       - `https://docs.google.com/spreadsheets/d/1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw/edit`
     - Slack channel `C09B1P21YQ0` (`#snap`)

2. **Auctions watchlist**
   - Goal: collect expiring/in-auction names from multiple auction platforms, filter them, consolidate them, write them to one Google Sheet, and post a Slack summary.
   - Outputs:
     - Google Sheet:
       - `https://docs.google.com/spreadsheets/d/1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks/edit`
     - Slack channel `C096AT8BECS` (`#auctions`)

There are also a few side workflows that are dump-based but not the main two products, especially:
- Sedo net-new monitoring
- NameJet exclusive diffing
- Drive-upload auction ingestion
- Atom dump retention / archiving

## 2) Shared filtering philosophy

A lot of these pipelines share the same basic idea:

- Pull a marketplace export, API result, Google Doc, Google Drive file, or scrape result.
- Filter to a narrow set of domain types.
- Score for quality or deal value.
- Save machine-readable artifacts in `data/`.
- Push shortlists into Google Sheets.
- Optionally post a Slack summary if there is something worth surfacing.

Core shared rules live in:
- `scripts/domain_filters.py`

Current shared rules include:
- Allowed TLDs: `.com`, `.org`, `.net`, `.io`, `.ai`, `.co`
- Strong preference for single clean words
- Uses word-quality filters from `word_rules.py`
- Zipf thresholds vary by TLD:
  - default `2.8`
  - `.io` override `3.8`
  - `.net` override `5.5`
- 3-letter `.com` names are explicitly allowed

This matters because the downstream sheet and Slack outputs are not raw dumps. They are already filtered and opinionated.

## 3) Where scheduling currently lives

Two scheduling systems are in play:

### A. System crontab
Current relevant jobs from `crontab -l`:

- **Afternic diff pipeline**: `5:15 AM ET`
  - Runs `scripts/run_afternic_diff.sh`
- **Fresh listings sublist refresh**: `7:05 AM ET`
  - Runs `scripts/refresh_sublist_sheet.py`
- **Client overlap report**: `7:00 AM ET`
  - Separate workflow, not part of SNAP/Auctions
- **Auction pipeline**: `6:00 AM ET`
  - Runs `scripts/publish_auction_shortlist.sh`
- **Auction watchdog**: `6:35 AM ET`
  - Runs `scripts/check_auction_publish.sh`
- **Atom daily folder ingest watcher**: every 10 minutes from `6:00 AM` through `10:59 AM ET`
  - Runs `scripts/process_daily_atom_folder.py`
- **Sedo net-new watcher**: `6:00 AM`, `1:00 PM`, `7:00 PM ET`
  - Runs `scripts/run_sedo_net_new.sh`
- **Efty partner daily ingest + diff**: `5:00 PM ET`
  - Runs `scripts/run_efty_partner_daily.sh`

### B. OpenClaw cron jobs
Relevant marketplace/dump jobs currently configured there:

- **Namecheap exclusive daily CSV diff**: `5:25 AM ET`
  - Runs `scripts/namecheap_daily_diff.py`
- **Atom Dumps Drive retention**: `9:35 AM ET`
  - Runs `scripts/atom_drive_retention.py`
- **Atom Wholesale daily doc refresh**: `10:05 AM ET`
  - Runs `scripts/process_atom_wholesale_doc.py`

So in practice, the system is split between Linux cron and OpenClaw cron.

## 4) SNAP: what it is operationally

“SNAP” is the main fresh-opportunity surfacing workflow, not one single source.

It currently consumes or is fed by:
- Afternic daily inventory diff
- Atom daily partner dump diff
- Namecheap daily BIN diff
- Atom Wholesale Google Doc ingestion
- In some cases, related overlap or target-map follow-on jobs

SNAP outputs go to:
- Fresh/running Google Sheet:
  - `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`
- Atom Wholesale running sheet:
  - `https://docs.google.com/spreadsheets/d/1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw/edit`
- Slack `#snap` channel `C09B1P21YQ0`

The SNAP-related tabs and behaviors are source-aware. The system tries to preserve rows from other sources while updating only the rows for the current source.

## 5) Afternic workflow

### Purpose
Daily BIN marketplace refresh to identify high-quality / high-deal Afternic names and push those into the SNAP sheet stack.

### Source
- Download URL inside `scripts/run_afternic_diff.sh`
- Fetches compressed Afternic inventory export

### Schedule
- Main cron: `5:15 AM ET`
- Also triggers sublist refresh as part of the wrapper script

### Main scripts
- `scripts/run_afternic_diff.sh`
- `scripts/afternic_diff.py`
- `scripts/update_afternic_net_new_sheet.py`
- `scripts/refresh_sublist_sheet.py`

### Storage
- Raw zip:
  - `data/afternic/inventory_latest.zip`
- Current CSV:
  - `data/afternic/inventory_latest.csv`
- Current ranked shortlist:
  - `data/afternic_top_250.json`
- Previous shortlist snapshot:
  - `data/afternic_top_250.prev.json`
- Top candidates subset:
  - `data/afternic_top_candidates.json`
- Diff payload:
  - `data/afternic_diff.json`
- Running-state snapshot for sheet diffing:
  - `data/afternic_sublist_latest.json`
- Net-new helper file:
  - `data/afternic_net_new.json`

### How it works
1. `run_afternic_diff.sh` downloads the latest inventory zip.
2. It unzips to `data/afternic/inventory_latest.csv`.
3. It checks whether the file has rolled for the current ET day.
4. If fresh, it runs `afternic_diff.py`.
5. `afternic_diff.py`:
   - parses the full CSV
   - filters allowed TLDs and clean words
   - computes frequency / quality / deal scores
   - creates a combined shortlist from top-by-quality and top-by-deal
   - saves current snapshot and diff artifacts
   - posts a Slack summary to `#snap`
6. The wrapper then runs:
   - `namejet_exclusive_diff.py`
   - `build_upgrade_target_map.py`
   - `run_upgrade_overlap.py`
   - `update_afternic_net_new_sheet.py`
   - `refresh_sublist_sheet.py`
7. `refresh_sublist_sheet.py` rebuilds:
   - `Running Good Deals`
   - `Today's New Listings`
   in the main SNAP sheet

### Google Sheet writes
Sheet:
- `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`

Tabs used:
- `Running Good Deals`
- `Today's New Listings`

Behavior:
- `Running Good Deals` is rebuilt from current Afternic shortlist plus preserved non-Afternic rows already in the sheet.
- `Today's New Listings` inserts only Afternic rows that are new relative to the saved previous state.
- Source label is explicitly `Afternic`.

### Slack push
- Channel: `C09B1P21YQ0`
- Message style: top movers / top new names plus full sheet link

### Important implementation detail
The current wrapper also refreshes the Afternic sublist sheet immediately after the main diff. There is also a separate 7:05 AM cron that runs `refresh_sublist_sheet.py` again, effectively serving as a second refresh pass.

## 6) Atom daily dump workflow

### Purpose
Monitor the daily Atom partner dump, detect net-new names vs. the prior day, and feed new qualifying names into SNAP.

### Source
- Google Drive folder `Atom Dumps`
- Folder ID in code: `1FFB8_8aTii5YQJheIQsJI0SqYRmFMg_4`

### Schedule
- Every 10 minutes from `6:00 AM` to `10:59 AM ET`
  - `scripts/process_daily_atom_folder.py`

### Main scripts
- `scripts/process_daily_atom_folder.py`
- `scripts/atom_diff.py`
- `scripts/atom_drive_retention.py`

### Storage
- Downloaded daily dump CSVs:
  - `data/atom_partner_YYYYMMDD.csv`
- Ingest state:
  - `data/atom_folder_ingest_state.json`
- Diff artifact:
  - `data/atom_diff.json`
- Raw Google Drive folder remains source of truth for originals

### How it works
1. `process_daily_atom_folder.py` looks for a Drive file named like:
   - `M-D-YY Atom Dump.csv`
2. It checks the Atom Dumps folder for today’s file.
3. If found and not already processed, it downloads the file into `data/atom_partner_YYYYMMDD.csv`.
4. It runs `atom_diff.py`.
5. `atom_diff.py` compares the newest dump vs. the previous dump.
6. It filters and scores domains similarly to the Afternic flow.
7. It writes net-new Atom rows into the SNAP sheet.
8. It also appends those names into `Running Good Deals` if not already present.
9. If there are fresh rows, it posts a Slack update to `#snap`.
10. It then attempts follow-on target-map / overlap jobs.

### Google Sheet writes
Sheet:
- `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`

Tabs used:
- `Today's New Listings`
- `Running Good Deals`

Behavior:
- `Today's New Listings` gets new rows labeled with source `Atom`.
- `Running Good Deals` gets appended with net-new Atom rows if the domain is not already present.
- This sheet is multi-source, so Atom is inserted alongside Afternic and Namecheap outputs.

### Slack push
- Channel: `C09B1P21YQ0`
- Message style: top new Atom names plus sheet link

### Retention / storage cleanup
`atom_drive_retention.py` manages Google Drive retention for the Atom dump folder.

Schedule:
- `9:35 AM ET` via OpenClaw cron

Rules:
- Keep files in live `Atom Dumps` folder for 14 days
- Move older files into `Atom Dumps Archive`
- Trash archived files older than 30 days

Retention state file:
- `data/atom_drive_retention_state.json`

## 7) Atom Wholesale Google Doc workflow

### Purpose
This is separate from the daily Atom partner dump. It ingests Judy’s Atom Wholesale Google Doc, extracts domains and prices, writes net-new rows into a dedicated running sheet, and posts all new rows to SNAP.

### Source
- Google Doc ID: `1-n-fiAOfTf9e5NaVSHCdgyNRTKdPuPBRx2A9XqwzczU`

### Schedule
- `10:05 AM ET` via OpenClaw cron

### Main script
- `scripts/process_atom_wholesale_doc.py`

### Storage
This workflow is lighter on local file artifacts. It mostly reads live from the Google Doc and writes directly to Sheets/Slack.

Persistent storage is primarily the destination Google Sheet itself.

### Google Sheet writes
Sheet:
- `https://docs.google.com/spreadsheets/d/1vrBxktnZ6cK5pY_w5EZa6DOA0E4OLU_Qs6x-fztDclw/edit`

Tab:
- `Running`

Behavior:
- Reads the whole doc as paragraphs
- Parses domain / price / notes blocks
- Filters to net-new domains only by checking existing sheet column A
- Inserts new rows at the **top** of the sheet under the header
- Stores metadata like:
  - domain
  - word / tld
  - zipf
  - brandability
  - deal score
  - price
  - source label `Atom Wholesale`
  - page / row position
  - notes / raw text

### Slack push
- Channel: `C09B1P21YQ0`
- Posts **all new rows**, not only the best few
- Marks rows that meet SNAP criteria
- Includes sheet link

### Important distinction
This is not a raw dump archival workflow. It is a doc-ingestion workflow that behaves like a marketplace feed.

## 8) Namecheap daily BIN diff workflow

### Purpose
Track daily changes in Namecheap Buy Now inventory, rank qualifying names, update the shared SNAP sheet, and Slack the net-new names.

### Source
- Public CSV export:
  - `https://d3ry1h4w5036x1.cloudfront.net/reports/Namecheap_Market_Sales_Buy_Now.csv`

### Schedule
- `5:25 AM ET` via OpenClaw cron

### Main script
- `scripts/namecheap_daily_diff.py`

### Storage
- Current CSV:
  - `data/namecheap_buy_now_daily.csv`
- Previous CSV:
  - `data/namecheap_buy_now_daily.prev.csv`
- Ranked shortlist:
  - `data/namecheap_top_250.json`
- Candidate subset:
  - `data/namecheap_top_candidates.json`
- Previous shortlist snapshot:
  - `data/namecheap_top_250.prev.json`
- Diff payload:
  - `data/namecheap_diff.json`
- Saved sheet state:
  - `data/namecheap_sublist_latest.json`
- Slack dedupe state:
  - `.state/namecheap_slack_post.json`

### How it works
1. Download the Namecheap Buy Now CSV.
2. Save current and previous snapshots.
3. Parse entries and filter by allowed domain rules.
4. Score by quality and deal.
5. Build combined shortlist.
6. Compare to previous shortlist.
7. Update `Today's New Listings` in the shared SNAP sheet with source `Namecheap`.
8. Save current state.
9. Post a Slack update to `#snap`.
10. Use a fingerprint file to avoid duplicate Slack posts.

### Google Sheet writes
Sheet:
- `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`

Tab:
- `Today's New Listings`

Behavior:
- Only Namecheap-source rows are replaced for the current report date.
- Other sources already in the sheet are preserved.

### Slack push
- Channel: `C09B1P21YQ0`
- Includes counts such as:
  - raw new names
  - filtered shortlist pool
  - ranked shortlist size
  - new qualifying names
  - rows added to sheet
  - removals
  - price changes

## 9) SNAP Google Sheet data model

The shared fresh-listings sheet is effectively a merged source board.

Sheet:
- `https://docs.google.com/spreadsheets/d/1FVgWVZMKDCVMXbkY0_SSfU73LCN29uyly7Tn6dUp8R8/edit#gid=0`

Important tabs:
- `Running Good Deals`
- `Today's New Listings`

What gets written there today:
- Afternic rows
- Atom daily dump rows
- Namecheap BIN rows
- potentially preserved non-Afternic rows from prior workflows

Typical columns across source writers:
- domain
- price
- tld
- zipf_score
- quality_score
- deal_score
- link
- date_added
- source
- sometimes `fast_transfer` and `prev_snapshot`

### Operational nuance
This sheet is not owned by one script. It is a shared destination with source-specific update logic.

That means a future rewrite should probably formalize:
- source-level ownership of rows
- schema consistency
- per-source idempotency
- a single merged writer instead of multiple partially-overlapping writers

## 10) Auctions workflow: what it is operationally

The auctions system is a separate multi-source pipeline that aggregates currently-ending auction names from many platforms, writes a combined watchlist to a dedicated Google Sheet, and posts a Slack summary.

Primary outputs:
- Sheet:
  - `https://docs.google.com/spreadsheets/d/1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks/edit`
- Slack:
  - channel `C096AT8BECS` (`#auctions`)

### Main orchestrator
- `scripts/publish_auction_shortlist.sh`

### Schedule
- Main run: `6:00 AM ET`
- Watchdog: `6:35 AM ET`

### Core sequence
1. Refresh each upstream source independently.
2. Track per-source success/failure in `data/auction_refresh_status.json`.
3. Push consolidated rows to the auctions Google Sheet.
4. Post Slack summary for active sources.
5. If the run did not fully complete, the watchdog retries the publish.

## 11) Auctions source list and current status model

Current source order in `publish_auction_shortlist.sh`:
- Dynadot
- Namecheap
- Drive auction uploads
- DropCatch
- Park.io
- GoDaddy
- NameSilo
- Sedo
- Sedo expired
- NameJet last chance
- NameJet email digest
- NameJet exclusive storefront

Each source gets a status written into:
- `data/auction_refresh_status.json`

Possible statuses include:
- `pending`
- `ok`
- `failed`
- `disabled`
- `skipped`

The downstream sheet push and Slack push consult this file so they can avoid publishing stale data for failed sources.

## 12) Auctions: per-source details

### 12.1 Dynadot

Source fetch:
- `scripts/dynadot_open_fetch.py --hours <horizon> --out /tmp/dynadot_open.json`

Filter step:
- `scripts/dynadot_filter.py`

Storage:
- raw fetch temp file: `/tmp/dynadot_open.json`
- filtered output: `dynadot_filtered.csv`

Use:
- Included in consolidated auctions sheet
- Included in Slack auctions summary

### 12.2 Namecheap auctions

Source fetch:
- `scripts/namecheap_auctions_crawl.py`

Storage:
- `namecheap_auctions_latest.json`

Use:
- Included in consolidated auctions sheet
- Included in Slack auctions summary

Notes:
- This is a different pipeline from the Namecheap daily BIN diff.
- Auctions flow uses the auction CSV/source and upcoming closing window.

### 12.3 Drive auction uploads

Source fetch:
- `scripts/scan_drive_auction_uploads.py`

Source location:
- Google Drive folder ID `1vCnJb4iJeVJnLiRk4BwO7TEbRY16-Gta`

Storage:
- raw downloaded files archived under:
  - `data/drive_uploads/raw/`
- parsed output:
  - `data/drive_uploads_filtered.json`

How it works:
- Scans recent Drive uploads from the last 36 hours
- Supports CSV and XLSX
- Detects NameJet-like upload formats specially
- Also supports generic spreadsheet headers
- Dedupes by domain

Use:
- Included in consolidated auctions sheet
- Hidden from the visible Slack source sections right now
- Still tracked in source status

### 12.4 DropCatch

Source fetch:
- `scripts/dropcatch_auctions_fetch.py`

Storage:
- `dropcatch_auctions_latest.json`

Use:
- Included in auctions sheet
- Included in auctions Slack post

### 12.5 Park.io

Source fetch:
- `scripts/parkio_auctions_fetch.py`

Storage:
- `parkio_auctions_latest.json`

Use:
- Included in auctions sheet
- Included in auctions Slack post

### 12.6 GoDaddy

Source fetch:
- `scripts/godaddy_auctions_fetch.py --hours <horizon> --out data/godaddy_auctions_filtered.json`

Storage:
- `data/godaddy_auctions_filtered.json`

Use:
- Included in auctions sheet
- Included in auctions Slack post

### 12.7 NameSilo

Source fetch:
- `scripts/namesilo_auctions_fetch.py --hours <horizon> --out data/namesilo_auctions_filtered.json`

Storage:
- `data/namesilo_auctions_filtered.json`

Use:
- Included in auctions sheet
- Included in auctions Slack post

### 12.8 Sedo expired auctions

Source fetch:
- `scripts/sedo_expired_fetch.py --tlds com,org,io --length-min 1 --length-max 12 --out data/sedo_expired_auctions.json`

Storage:
- `data/sedo_expired_auctions.json`

Use:
- Included in auctions sheet
- Included in auctions Slack post

### 12.9 Sedo fresh search export

Source fetch:
- `scripts/sedo_expiring_export.py --tlds com,net,ai,co --length-min 1 --length-max 12 --max-words 1 --max-age 12 --size 500`

Schedule:
- separate watcher at `6:00 AM`, `1:00 PM`, `7:00 PM ET`

Main wrapper:
- `scripts/run_sedo_net_new.sh`

Storage:
- the wrapper itself does not show the final path, but the workflow uses the Sedo export plus `scripts/sedo_net_new_slack.py`

Use:
- Separate net-new monitoring flow, not the main auctions Slack section
- The main auction publish script also marks Sedo source status, but the visible aggregated sheet/slack code currently focuses on `sede_expired` for structured rows

### 12.10 NameJet sources

There are multiple NameJet-related scripts in the repo, but the main auction orchestrator is currently **not** using the older direct NameJet sources in the normal publish.

In `publish_auction_shortlist.sh` these are currently explicitly disabled:
- NameJet last chance
- NameJet email digest ingest
- NameJet exclusive storefront

What the script does instead:
- writes empty placeholders such as:
  - `data/namejet_lastchance_full.json`
  - `data/namejet_email_filtered.json`
  - `data/namejet/namejet_exclusive_latest.json`
- marks those sources as `disabled`
- reason text says the workflow is using Judy Drive dumps instead

That means the current production auction publish path has effectively shifted away from direct NameJet source ingestion and toward Drive-upload-based handling.

## 13) Auctions sheet writer

Main script:
- `scripts/push_auctions_to_sheet.py`

Destination sheet:
- `https://docs.google.com/spreadsheets/d/1-k9SNFNm6ontOC6_P8wW3PTMk65YYpSAx7kM4rmKjks/edit`

Range written:
- `Sheet1!A2:E`

Columns written:
- end timestamp UTC string
- time left
- domain
- price
- platform

How it works:
1. Read `auction_refresh_status.json`
2. Skip failed, disabled, or skipped sources
3. Parse each source’s local artifact file
4. Normalize all rows to a common schema
5. Sort by auction end time
6. Prepend new rows to the existing sheet contents

Important nuance:
- This is not a full replace of historical rows.
- It combines new current rows with the existing sheet contents, then rewrites the range.
- So the sheet acts like a growing running log / board rather than a pure snapshot table.

## 14) Auctions Slack writer

Main script:
- `scripts/post_auction_watchlist.py`

Slack destination:
- channel `C096AT8BECS`

How it works:
- Reads the same source artifacts as the sheet writer
- Reads `auction_refresh_status.json`
- Hides or annotates failed/disabled sources
- Builds source-by-source sections
- Posts a consolidated morning watchlist summary

Visible sections currently include:
- Namecheap
- Dynadot
- DropCatch
- Park.io
- GoDaddy
- NameSilo
- Sedo Expired

Important current preference reflected in code/memory:
- Drive Uploads are not published as their own Slack section
- Older NameJet email / exclusive / last-chance sections are also not published as standalone Slack sections

## 15) Auctions watchdog / resiliency

Main script:
- `scripts/check_auction_publish.sh`

Purpose:
- Confirm the morning auction publish finished cleanly
- Retry if no success marker is present
- Log remaining failed sources if the publish technically completed but some upstream sources failed

What it checks:
- looks for `PUBLISH SUCCESS` in:
  - `logs/auction_publish_cron.log`
- inspects failed sources from:
  - `data/auction_refresh_status.json`

If publish success is missing:
- reruns `publish_auction_shortlist.sh` with a timeout

This is basically the safety net for the auctions workflow.

## 16) Other dump-like workflows in this ecosystem

### Efty partner diff
Artifacts observed in the workspace:
- `data/efty_partner_latest.csv`
- `data/efty_partner_diff.json`

Schedule:
- `5:00 PM ET`

Role:
- Separate partner feed / diff workflow
- Not part of the main SNAP sheet or main auctions sheet, but clearly part of the broader marketplace-monitoring setup

### NameJet exclusive diff
Main script:
- `scripts/namejet_exclusive_diff.py`

Artifacts:
- `data/namejet/namejet_exclusive_latest.json`
- `data/namejet/namejet_exclusive_prev.json`
- `data/namejet/namejet_exclusive_diff.json`

Role:
- Tracks diffs on NameJet exclusive snapshots when snapshots exist
- Currently not used as a live source section in the main auctions publish path

## 17) Key file and artifact map

### SNAP / marketplace freshness
- `data/afternic/inventory_latest.zip`
- `data/afternic/inventory_latest.csv`
- `data/afternic_top_250.json`
- `data/afternic_top_250.prev.json`
- `data/afternic_diff.json`
- `data/afternic_sublist_latest.json`
- `data/afternic_net_new.json`
- `data/atom_partner_YYYYMMDD.csv`
- `data/atom_folder_ingest_state.json`
- `data/atom_diff.json`
- `data/namecheap_buy_now_daily.csv`
- `data/namecheap_buy_now_daily.prev.csv`
- `data/namecheap_top_250.json`
- `data/namecheap_top_250.prev.json`
- `data/namecheap_diff.json`
- `data/namecheap_sublist_latest.json`
- `.state/namecheap_slack_post.json`

### Auctions
- `data/auction_refresh_status.json`
- `namecheap_auctions_latest.json`
- `dynadot_filtered.csv`
- `dropcatch_auctions_latest.json`
- `parkio_auctions_latest.json`
- `data/godaddy_auctions_filtered.json`
- `data/namesilo_auctions_filtered.json`
- `data/sedo_expired_auctions.json`
- `data/drive_uploads_filtered.json`
- `data/drive_uploads/raw/*`
- placeholder / legacy-disabled NameJet files:
  - `data/namejet_lastchance_full.json`
  - `data/namejet_email_filtered.json`
  - `data/namejet/namejet_exclusive_latest.json`

## 18) What Claude should understand if formalizing this

If this gets turned into a cleaner productized system, these are the main realities to preserve:

1. **There are multiple source types**
   - raw CSV dumps
   - Drive files
   - Google Docs
   - JSON scrape outputs
   - marketplace exports

2. **SNAP is a merged downstream product, not one source**
   - multiple producers write to one shared Google Sheet
   - source ownership is implicit in labels and update logic

3. **Auctions is an orchestrated multi-source refresh with partial-failure tolerance**
   - each source can fail independently
   - publish can still proceed with remaining sources
   - source status is part of the contract

4. **Current system mixes cron layers**
   - Linux crontab
   - OpenClaw cron
   - this should probably be unified eventually

5. **State is file-based**
   - previous snapshots and diffing rely heavily on JSON files in `data/`
   - idempotency and “what changed” logic are local-file driven

6. **Google Sheets are being used as both output and stateful working surfaces**
   - some tabs are snapshots
   - some are append/prepend running logs
   - some preserve rows from other sources

7. **Slack messages are operational outputs, not the source of truth**
   - source of truth is local artifacts + Google Sheets

## 19) Recommended refactor directions

If Claude is helping formalize/code this up, the biggest opportunities are:

1. Build a formal source registry
   - source name
   - source type
   - schedule
   - artifact paths
   - parser
   - filters
   - sheet destination
   - slack destination

2. Separate stages clearly
   - fetch
   - normalize
   - filter/score
   - diff
   - publish-to-sheet
   - publish-to-slack

3. Make schemas explicit
   - one normalized schema for marketplace fresh listings
   - one normalized schema for auction rows

4. Centralize state
   - instead of many ad hoc JSONs, define source snapshot + diff contracts

5. Centralize row ownership rules for shared sheets
   - especially `Today's New Listings` and `Running Good Deals`

6. Unify scheduling
   - one scheduler if possible
   - or at least one registry of all schedule definitions

7. Add observability
   - per-source run logs
   - last successful refresh timestamps
   - row counts by source
   - Slack publish dedupe / idempotency consistently across all flows

## 20) Canonical script entry points

If someone is trying to understand or re-run the current production logic, these are the best entry points.

### SNAP-related
- `scripts/run_afternic_diff.sh`
- `scripts/refresh_sublist_sheet.py`
- `scripts/process_daily_atom_folder.py`
- `scripts/atom_diff.py`
- `scripts/process_atom_wholesale_doc.py`
- `scripts/namecheap_daily_diff.py`

### Auctions-related
- `scripts/publish_auction_shortlist.sh`
- `scripts/push_auctions_to_sheet.py`
- `scripts/post_auction_watchlist.py`
- `scripts/check_auction_publish.sh`
- `scripts/scan_drive_auction_uploads.py`
- `scripts/namecheap_auctions_crawl.py`
- `scripts/dynadot_filter.py`

## 21) Bottom line

Operationally, the system is doing three distinct things:

1. **Daily marketplace freshness detection** for BIN / inventory sources like Afternic, Atom, and Namecheap, feeding SNAP.
2. **Auction aggregation** across multiple auction platforms, feeding the auctions sheet and Slack post.
3. **Auxiliary feed monitoring** for special sources like Atom Wholesale, Sedo net-new, Efty partner, and Drive uploads.

The current implementation works, but it is spread across many scripts, two schedulers, several local state files, and shared-sheet update patterns that are only partially standardized. That makes it a strong candidate for formalization into a registry-driven pipeline architecture.
