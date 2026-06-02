-- ============================================================================
-- Read-only REST bridge for the `claude_ro` role.
--
-- WHY: Claude Code on the web can only egress over ports 80/443 (HTTP proxy),
-- so the direct-Postgres `claude_ro` pooler URL (5432) never connects. This
-- exposes the same read-only role over HTTPS/443 via a PostgREST RPC, so
-- `scripts/db.py` works from web sessions.
--
-- SECURITY MODEL:
--   * The RPC is SECURITY DEFINER, owned by `claude_ro` (SELECT-only + BYPASSRLS),
--     so it runs read-only — `claude_ro` has no write grants, so any non-SELECT
--     statement passed in just errors out. Read-only by construction.
--   * Wrapping the query as a subquery blocks statement-chaining injection.
--   * A shared token gates access so the *public* anon key can't read through it.
--     The token lives in a private table only `claude_ro` can read.
--
-- Run this in each project's Supabase SQL editor (as the project admin — the
-- `claude_ro` role can't grant to itself). Replace the token before running.
-- Generate one with:  select encode(gen_random_bytes(24), 'hex');
-- ============================================================================

-- 1. Private token table — only claude_ro may read it (BYPASSRLS); RLS-on with
--    no policies blocks anon/authenticated.
create table if not exists public._claude_ro_auth (token text not null);
alter table public._claude_ro_auth enable row level security;
revoke all on public._claude_ro_auth from public;
grant select on public._claude_ro_auth to claude_ro;

-- 2. Store the shared read-only token. >>> REPLACE THE VALUE BELOW <<<
delete from public._claude_ro_auth;
insert into public._claude_ro_auth(token) values ('REPLACE_WITH_RANDOM_TOKEN');

-- 3. claude_ro must be able to own the SECURITY DEFINER function.
grant create on schema public to claude_ro;

-- 4. The bridge: run a read-only query, return JSON (json_agg preserves the
--    SELECT's column order), executed as the owner (claude_ro). Token-gated.
create or replace function public.claude_ro_query(q text, token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  result json;
begin
  if token is distinct from (select t.token from public._claude_ro_auth t limit 1) then
    raise exception 'unauthorized';
  end if;
  perform set_config('statement_timeout', '30000', true);  -- 30s safety cap
  execute 'select coalesce(json_agg(x), ''[]''::json) from (' || q || ') x'
    into result;
  return result;
end;
$$;

-- 5. Run AS claude_ro (read-only), not the postgres superuser.
alter function public.claude_ro_query(text, text) owner to claude_ro;

-- 6. Reachable only through PostgREST's anon role (the gateway key) — nothing broad.
revoke all on function public.claude_ro_query(text, text) from public;
grant execute on function public.claude_ro_query(text, text) to anon;

-- 7. Tell PostgREST about the new RPC.
notify pgrst, 'reload schema';
