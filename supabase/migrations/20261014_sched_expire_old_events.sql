create extension if not exists pg_cron;

-- Delete events whose last date has fully passed in the event's own timezone.
-- sched_responses rows go with them (on delete cascade).
create or replace function public.sched_delete_expired_events()
returns integer language sql security invoker set search_path = public as $$
  with gone as (
    delete from public.sched_events e
     where (select max(d) from unnest(e.dates) d) < (now() at time zone e.tz)::date
    returning 1
  )
  select count(*)::int from gone;
$$;
revoke execute on function public.sched_delete_expired_events() from public, anon, authenticated;

-- Hourly, so every timezone is cleaned up soon after its midnight.
select cron.unschedule(jobid) from cron.job where jobname = 'sched-delete-expired-events';
select cron.schedule('sched-delete-expired-events', '5 * * * *', $$select public.sched_delete_expired_events()$$);
