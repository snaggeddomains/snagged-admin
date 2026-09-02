-- Gmail read governor — the shared ledger every mailbox read charges against, so no
-- feature (or the sum of them) can eat the per-user Gmail quota Superhuman shares.
-- Run once on the domain-owner-research (PRODUCTION) project — the one holding the other
-- domain_research_* / deals tables, NOT snagged-naming-universe.
-- Idempotent.

create table if not exists gmail_read_budget (
  mailbox     text        not null,
  day         date        not null,
  reads       integer     not null default 0,
  est_bytes   bigint      not null default 0,
  by_feature  jsonb       not null default '{}'::jsonb,   -- {feature: {reads, bytes}}
  updated_at  timestamptz not null default now(),
  primary key (mailbox, day)
);

alter table gmail_read_budget enable row level security;  -- service key bypasses; no anon policy

-- Atomic charge: increment the (mailbox, day) row's totals AND the per-feature sub-counter in
-- one statement, returning the running totals so the caller can enforce the cap without a race.
create or replace function gmail_charge_read(
  p_mailbox text,
  p_day     date,
  p_feature text,
  p_reads   integer,
  p_bytes   bigint
) returns table (reads integer, est_bytes bigint)
language plpgsql as $$
declare
  cur_reads integer;
  cur_bytes bigint;
begin
  insert into gmail_read_budget (mailbox, day, reads, est_bytes, by_feature, updated_at)
  values (
    p_mailbox, p_day, p_reads, p_bytes,
    jsonb_build_object(p_feature, jsonb_build_object('reads', p_reads, 'bytes', p_bytes)),
    now()
  )
  on conflict (mailbox, day) do update set
    reads      = gmail_read_budget.reads + excluded.reads,
    est_bytes  = gmail_read_budget.est_bytes + excluded.est_bytes,
    by_feature = jsonb_set(
      gmail_read_budget.by_feature,
      array[p_feature],
      jsonb_build_object(
        'reads', coalesce((gmail_read_budget.by_feature -> p_feature ->> 'reads')::int, 0) + p_reads,
        'bytes', coalesce((gmail_read_budget.by_feature -> p_feature ->> 'bytes')::bigint, 0) + p_bytes
      ),
      true
    ),
    updated_at = now()
  returning gmail_read_budget.reads, gmail_read_budget.est_bytes
  into cur_reads, cur_bytes;

  reads := cur_reads;
  est_bytes := cur_bytes;
  return next;
end;
$$;
