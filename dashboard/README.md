# Dashboard

Next.js (App Router) app deployed on Vercel. Reads pipeline state JSON from
the repo via the GitHub Contents API; reads the name universe from R2 (DuckDB
+ Parquet) once that is wired up.

## Local dev

```bash
cd dashboard
npm install
npm run dev
```

Open http://localhost:3000.

## Deployment

In Vercel:
- Project root: `dashboard/`
- Framework preset: Next.js (autodetected)
- Environment variables: set under Project Settings -> Environment Variables.
  See `../.env.example` for the full list; the dashboard only needs the read
  side (`GITHUB_TOKEN` for repo state, `R2_*` for the name universe).
