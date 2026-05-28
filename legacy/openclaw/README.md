# Legacy OpenClaw scripts (frozen reference)

A frozen snapshot of the OpenClaw workspace's marketplace and auctions scripts
as of 2026-05-28, imported as a reference for the rebuild under
`src/marketplace_pipeline/`.

**Do not edit files in this directory.** They are read-only inputs to the
rebuild. When a source is ported to the new pipeline, its corresponding legacy
script(s) should be deleted in the same commit (or batch).

## Sanitization applied on import

- `scripts/efty_partner_ingest.py:30` — removed hardcoded fallback for
  `EFTY_PARTNER_TOKEN`. Original line had a 64-char hex token baked in as the
  `os.environ.get` default; the import here drops the default so the script
  fails loudly if the env var is missing, and the value is no longer present in
  this repo's git history.

## Contents

- `scripts/` — 41 Python and shell scripts covering SNAP and Auctions
- `_meta/` — manifest of the original export, plus production schedule
  documentation (`linux_crontab.txt`, `openclaw_cron.txt`)

For the operational overview, see
[`../../docs/domain-dumps-and-platform-workflows.md`](../../docs/domain-dumps-and-platform-workflows.md).
For the rebuild spec, see
[`../../docs/domain-dumps-and-platform-workflows-spec.md`](../../docs/domain-dumps-and-platform-workflows-spec.md).
