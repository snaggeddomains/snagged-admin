-- Feedback / Feature Requests — one central queue any logged-in user can add to (pick a module +
-- an addition/tweak/new-module idea). On a new submission ONLY rob@snagged.com gets a bell + email;
-- only Rob (admin / admin.feedback.manage) can see + manage the whole queue. Run once on the MAIN
-- project. RLS enabled (service key bypasses).
create table if not exists feature_requests (
  id                 uuid primary key default gen_random_uuid(),
  submitted_by       text,            -- email of the submitter
  submitted_by_name  text,            -- their display name (snapshot)
  module             text,            -- which existing module/area it's about (or "New module / other")
  kind               text not null default 'tweak',   -- addition | tweak | new_module | bug | other
  title              text not null,
  body               text,
  status             text not null default 'open',     -- open | planned | in_progress | shipped | declined
  admin_notes        text,            -- Rob's notes
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_feature_requests_status on feature_requests (status, created_at desc);
create index if not exists idx_feature_requests_submitter on feature_requests (submitted_by, created_at desc);
alter table feature_requests enable row level security;
