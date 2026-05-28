# snagged-admin

Marketplace data pipelines (SNAP + Auctions) feeding Slack and Google Sheets,
with a Vercel dashboard for monitoring and a queryable name universe
(DuckDB + Parquet on R2) for future brand-naming workflows.

## Layout

- `src/marketplace_pipeline/` — new pipeline code (Python)
- `dashboard/` — Vercel / Next.js dashboard
- `legacy/openclaw/` — frozen reference of the previous OpenClaw scripts; do not edit
- `docs/` — architecture and operational docs
- `state/` — committed pipeline state (snapshots, diffs, run status)
- `.github/workflows/` — scheduled pipeline runs

See `docs/domain-dumps-and-platform-workflows.md` for the system overview and
`docs/domain-dumps-and-platform-workflows-spec.md` for the rebuild spec.
