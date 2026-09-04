-- Email snippets — reusable boilerplate language (engagement terms, call-recap template, etc.) for
-- the Email tools (Compose / Follow-up). Shared across the team, editable in-app. Run on the
-- `domain-owner-research` PRODUCTION project (the one with the other domain_research_*/deals tables
-- — NOT snagged-naming-universe).
create table if not exists email_snippets (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  created_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table email_snippets enable row level security; -- service key bypasses; no policies = closed

-- A couple of starters (idempotent — only inserted if the table is empty).
insert into email_snippets (title, body)
select * from (values
  ('Standard engagement terms',
   'Our standard terms are simple: a 10% success fee, nothing upfront. You only pay when we actually land the domain at a price you''ve approved — if we don''t get it, you owe us nothing. We handle the outreach, negotiation, and escrow end to end.'),
  ('Call recap template',
   'Great speaking with you today. To recap what we covered:' || chr(10) ||
   '- Your goal: [what they want]' || chr(10) ||
   '- Target name(s): [domains discussed]' || chr(10) ||
   '- Budget / ceiling: [range]' || chr(10) ||
   '- Next step: [what happens next]' || chr(10) ||
   'Let me know if I captured anything wrong.'),
  ('No-risk reassurance',
   'To be clear, there''s no risk on your end — nothing is owed unless we successfully acquire the name at a price you sign off on. We front the work.')
) as v(title, body)
where not exists (select 1 from email_snippets);
