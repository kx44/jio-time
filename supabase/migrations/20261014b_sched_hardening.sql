-- Only the edge functions (service role) touch these tables. Drop the default
-- anon/authenticated grants; RLS already blocks rows, but TRUNCATE ignores RLS.
revoke all on public.sched_events, public.sched_responses from anon, authenticated;

-- Cap how many chats one event can be shared into, so one event can't make
-- every save fan out into hundreds of Telegram edits.
create or replace function public.sched_add_inline_message(p_event_id text, p_inline_message_id text, p_user_id bigint)
returns void language sql security invoker set search_path = public as $$
  update public.sched_events
     set inline_message_ids = case
           when p_inline_message_id = any(inline_message_ids) or cardinality(inline_message_ids) >= 20
             then inline_message_ids
           else array_append(inline_message_ids, p_inline_message_id) end,
         creator_id = coalesce(creator_id, p_user_id)
   where id = p_event_id;
$$;
revoke execute on function public.sched_add_inline_message(text, text, bigint) from public, anon, authenticated;

-- Also clear out anonymous events that were never shared into a chat within 2 hours,
-- so spammed creates can't pile up.
create or replace function public.sched_delete_expired_events()
returns integer language sql security invoker set search_path = public as $$
  with gone as (
    delete from public.sched_events e
     where (select max(d) from unnest(e.dates) d) < (now() at time zone e.tz)::date
        or (e.creator_id is null and cardinality(e.inline_message_ids) = 0
            and e.created_at < now() - interval '2 hours')
    returning 1
  )
  select count(*)::int from gone;
$$;
revoke execute on function public.sched_delete_expired_events() from public, anon, authenticated;
