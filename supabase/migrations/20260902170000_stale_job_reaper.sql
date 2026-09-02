-- Klylo video queue — stale job reaper.
-- Idempotent: safe to run more than once in the Supabase SQL editor (as the `postgres` role).
--
-- The worker is a Route Handler driven by the browser, so a job can be stranded two ways:
--   * `processing` — the tab closed between the claim and the finalize.
--   * `queued`     — the POST to the worker never landed (offline, a 5xx, tab closed).
-- Neither recovers on its own, and `JobCard` only offers Retry on `failed`. Failing a
-- stranded job therefore both tells the truth and hands the user the existing Retry path.

-- 1. Let a caller set `updated_at` explicitly ---------------------------------
-- The trigger used to stamp `now()` on every update, which made "pretend this row is old"
-- impossible to express — including for the reaper's own tests. Now an update that leaves
-- `updated_at` alone gets the stamp (the common case), and one that sets it is respected.
-- Under RLS a user can only do this to their own rows, so the blast radius is their own job.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

-- 2. The reaper ---------------------------------------------------------------
-- 90 s is comfortably past the worst legitimate run: the route declares `maxDuration = 60`
-- and sleeps at most 15 s, so nothing healthy is still `processing` at 90 s.
create or replace function public.reap_stale_jobs()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  reaped integer;
begin
  with stale as (
    update public.jobs
       set status        = 'failed',
           error_message = case status
             when 'processing' then 'Worker stopped responding; the job was marked failed so it can be retried.'
             else 'The job was never picked up by a worker; retry to submit it again.'
           end
     where status in ('queued', 'processing')
       and updated_at < now() - interval '90 seconds'
    returning 1
  )
  select count(*) into reaped from stale;

  return reaped;
end;
$$;

-- `security definer` means this runs as the owner and sees every row, so no client role may
-- call it — otherwise one user could fail another's in-flight job. Only cron invokes it.
revoke execute on function public.reap_stale_jobs() from public;
revoke execute on function public.reap_stale_jobs() from anon;
revoke execute on function public.reap_stale_jobs() from authenticated;

-- 3. Schedule it --------------------------------------------------------------
-- Wrapped so the migration still succeeds where `pg_cron` is unavailable; the function is
-- then present but unscheduled, and the notice says so.
do $$
begin
  create extension if not exists pg_cron;

  if exists (select 1 from cron.job where jobname = 'reap-stale-jobs') then
    perform cron.unschedule('reap-stale-jobs');
  end if;

  perform cron.schedule('reap-stale-jobs', '* * * * *', 'select public.reap_stale_jobs()');
exception
  when others then
    raise notice 'pg_cron unavailable (%), reap_stale_jobs() created but not scheduled.', sqlerrm;
end
$$;
