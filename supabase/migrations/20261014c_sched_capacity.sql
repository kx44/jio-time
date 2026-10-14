alter table public.sched_events
  add column if not exists create_ip_hash text,
  add column if not exists last_edit_at timestamptz,
  add column if not exists edit_due_at timestamptz;

create index if not exists sched_events_ip_created_idx on public.sched_events (create_ip_hash, created_at)
  where create_ip_hash is not null;

-- Coalesce Telegram message edits: at most one per event every p_min_gap_ms.
-- Returns the delay (ms) the caller should wait before editing, or NULL when an
-- edit is already pending (that edit reads the latest data when it fires).
-- A pending claim goes stale after 10s in case its invocation died.
create or replace function public.sched_claim_edit(p_event_id text, p_min_gap_ms int)
returns int language sql security invoker set search_path = public as $$
  update public.sched_events
     set edit_due_at = greatest(now(), coalesce(last_edit_at, '-infinity'::timestamptz)
                                       + make_interval(secs => p_min_gap_ms / 1000.0))
   where id = p_event_id
     and (edit_due_at is null or edit_due_at < now() - interval '10 seconds')
  returning greatest(0, ceil(extract(epoch from (edit_due_at - now())) * 1000))::int;
$$;
revoke execute on function public.sched_claim_edit(text, int) from public, anon, authenticated;

-- Called when the scheduled edit fires, before it reads the data, so any save that
-- lands afterwards schedules a fresh edit instead of being lost.
create or replace function public.sched_start_edit(p_event_id text)
returns void language sql security invoker set search_path = public as $$
  update public.sched_events set last_edit_at = now(), edit_due_at = null where id = p_event_id;
$$;
revoke execute on function public.sched_start_edit(text) from public, anon, authenticated;
