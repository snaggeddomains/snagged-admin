-- Per-domain broker notes for the Marketplace deal report.
-- Free-text off-platform activity (offers over text/WhatsApp/phone, verbal
-- context, next steps) that never lands in Gmail/HubSpot. Saved from the admin
-- report and folded into the generated client Doc.
--
-- Run in the ADMIN Supabase project (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY —
-- the same project as marketplace_deal_reports).

create table if not exists marketplace_deal_notes (
  domain     text primary key,
  notes      text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text
);

-- RLS on with no policies: the app uses the service-role key (which bypasses
-- RLS), so this closes anon/public access without breaking anything.
alter table marketplace_deal_notes enable row level security;
