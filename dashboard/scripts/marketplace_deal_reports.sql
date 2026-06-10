-- Cache for the per-domain Marketplace ACTIVITY drill-down (sell-side deal report
-- reconstructed from the deal mailboxes). Generating one scans many Gmail threads
-- (a few minutes), so the result is cached here and re-used for FRESH_MS (6h).
-- Lives in the snagged-admin admin Supabase (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY),
-- same project as the import log / x_ads cache. RLS on, no policies (service key bypasses).
create table if not exists marketplace_deal_reports (
  domain        text primary key,
  report        jsonb not null,
  generated_at  timestamptz not null default now()
);
alter table marketplace_deal_reports enable row level security;
