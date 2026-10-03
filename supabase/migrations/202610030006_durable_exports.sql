-- Temporary download metadata survives a worker restart and owns its Storage key.
-- Deliberately no Auth/chat FK: cleanup must remain discoverable after deletion.
create table public.dbchat_exports (
  id uuid primary key,
  user_id uuid not null,
  chat_id text not null,
  worker_id uuid not null,
  title text not null,
  format text not null check (format in ('csv','xlsx','json','html','markdown')),
  scope text not null check (scope in ('visible','all','report')),
  status text not null check (status in ('queued','running','ready','error','cancelled')),
  executing boolean not null default false,
  row_count bigint not null default 0,
  byte_count bigint not null default 0,
  error text,
  limits jsonb not null,
  object_key text not null unique,
  object_deleted boolean not null default false,
  remove_requested boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  lease_until timestamptz not null,
  cleanup_token uuid,
  cleanup_until timestamptz,
  cleanup_after timestamptz not null default clock_timestamp(),
  tombstone_until timestamptz
);
create index dbchat_exports_owner_chat on public.dbchat_exports(user_id,chat_id);
create index dbchat_exports_cleanup on public.dbchat_exports(expires_at,lease_until);
alter table public.dbchat_exports enable row level security;
revoke all on public.dbchat_exports from public,anon,authenticated;
grant all on public.dbchat_exports to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('dbchat-exports','dbchat-exports',false,1073741824,array['application/octet-stream'])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy dbchat_exports_private on storage.objects as restrictive for all to anon,authenticated
using (bucket_id <> 'dbchat-exports') with check (bucket_id <> 'dbchat-exports');

create function public.dbchat_export_create(p_owner uuid,p_id uuid,p_worker uuid,p_chat text,p_details jsonb,p_limits jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dbchat_exports; now_at timestamptz := clock_timestamp();
begin
  perform public.dbchat_assert_account_active(p_owner);
  perform pg_advisory_xact_lock(hashtextextended('dbchat-exports',0));
  now_at := clock_timestamp();
  if not exists(select 1 from dbchat_chats where id=p_chat and user_id=p_owner) then raise exception 'Chat not found'; end if;
  if (select count(*) from dbchat_exports where user_id=p_owner and (not object_deleted or (not remove_requested and expires_at>now_at))) >= 5 then raise exception 'DBCHAT_EXPORT_ACCOUNT_LIMIT'; end if;
  if (select count(*) from dbchat_exports where not object_deleted or (not remove_requested and expires_at>now_at)) >= 10 then raise exception 'DBCHAT_EXPORT_GLOBAL_LIMIT'; end if;
  if (p_limits->>'maxBytes')::bigint not between 1 and 1073741824
     or (p_limits->>'maxRows')::bigint not between 1 and 10000000
     or (p_limits->>'timeoutMs')::bigint not between 1 and 1800000
     or (p_limits->>'ttlMs')::bigint not between 1 and 86400000 then raise exception 'Invalid export limits'; end if;
  insert into dbchat_exports(id,user_id,chat_id,worker_id,title,format,scope,status,limits,object_key,expires_at,lease_until)
  values(p_id,p_owner,p_chat,p_worker,left(p_details->>'title',200),p_details->>'format',p_details->>'scope','queued',p_limits,
    p_owner::text||'/'||p_id::text||'.export',now_at+((p_limits->>'ttlMs')::bigint*interval '1 millisecond'),now_at+interval '90 seconds')
  returning * into result;
  return to_jsonb(result);
end $$;

-- Heartbeats never revive an expired execution. Starting is serialized globally.
create function public.dbchat_export_tick(p_id uuid,p_worker uuid,p_start boolean default false)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dbchat_exports; now_at timestamptz := clock_timestamp();
begin
  select * into result from dbchat_exports where id=p_id and worker_id=p_worker;
  if not found then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||result.user_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('dbchat-exports',0));
  select * into result from dbchat_exports where id=p_id and worker_id=p_worker for update;
  now_at := clock_timestamp();
  if not found or result.lease_until<=now_at then return null; end if;
  if result.status not in ('queued','running','cancelled') then return to_jsonb(result); end if;
  if result.expires_at<=now_at or exists(select 1 from dbchat_account_deletions where owner=result.user_id) then
    update dbchat_exports set status='cancelled' where id=p_id returning * into result;
  end if;
  if p_start and result.status='queued'
     and (select count(*) from dbchat_exports where executing and lease_until>now_at)<2
     and not exists(select 1 from dbchat_exports where user_id=result.user_id and executing and lease_until>now_at) then
    update dbchat_exports set status='running',executing=true where id=p_id returning * into result;
  end if;
  update dbchat_exports set lease_until=now_at+interval '90 seconds' where id=p_id returning * into result;
  return to_jsonb(result);
end $$;

create function public.dbchat_export_finish(p_id uuid,p_worker uuid,p_status text,p_rows bigint,p_bytes bigint)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dbchat_exports; now_at timestamptz := clock_timestamp();
begin
  select * into result from dbchat_exports where id=p_id and worker_id=p_worker;
  if not found then raise exception 'Export worker lease lost'; end if;
  perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||result.user_id::text,0));
  select * into result from dbchat_exports where id=p_id and worker_id=p_worker for update;
  now_at := clock_timestamp();
  if not found or result.lease_until<=now_at then raise exception 'Export worker lease lost'; end if;
  if result.status in ('ready','error') then return to_jsonb(result); end if;
  if p_status not in ('ready','error','cancelled') then raise exception 'Invalid export state'; end if;
  if p_status='ready' then
    perform public.dbchat_assert_account_active(result.user_id);
    if result.status<>'running' or result.expires_at<=now_at then raise exception 'Export publication is no longer allowed'; end if;
    if p_rows<0 or p_bytes<0 or p_rows>(result.limits->>'maxRows')::bigint or p_bytes>(result.limits->>'maxBytes')::bigint then raise exception 'Export limit exceeded'; end if;
  end if;
  update dbchat_exports set executing=false,status=case when status='cancelled' then 'cancelled' else p_status end,
    row_count=p_rows,byte_count=p_bytes,error=case when p_status='error' then 'The export could not be completed. Generate it again from the chat.' else null end
  where id=p_id returning * into result;
  return to_jsonb(result);
end $$;

create function public.dbchat_export_cancel(p_owner uuid,p_id uuid default null,p_remove boolean default false)
returns void language sql security definer set search_path=public,pg_temp as $$
  update dbchat_exports set status='cancelled',remove_requested=remove_requested or p_remove,error=null
  where user_id=p_owner and (p_id is null or id=p_id);
$$;

create function public.dbchat_export_stop_worker(p_worker uuid)
returns void language sql security definer set search_path=public,pg_temp as $$
  update dbchat_exports set status='cancelled',error=null
  where worker_id=p_worker and status in ('queued','running');
$$;

-- Claims are serialized with publication. A worker can never publish a claimed
-- object, and the claim token fences a delayed cleanup acknowledgement.
create function public.dbchat_export_cleanup_claim(p_token uuid)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dbchat_exports; now_at timestamptz := clock_timestamp();
begin
  update dbchat_exports set status='error',executing=false,error='The server restarted before this export completed. Generate it again from the chat.'
  where status in ('queued','running','cancelled') and lease_until<=now_at and (status<>'cancelled' or executing);
  update dbchat_exports set status='cancelled' where expires_at<=now_at and status in ('queued','running','ready');
  select * into result from dbchat_exports
    where not executing and (expires_at<=now_at or remove_requested or status in ('cancelled','error'))
      and (not object_deleted or expires_at<=now_at or remove_requested)
      and cleanup_after<=now_at and (cleanup_until is null or cleanup_until<=now_at)
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  now_at := clock_timestamp();
  if result.executing or (result.expires_at>now_at and not result.remove_requested and result.status not in ('cancelled','error'))
    or result.cleanup_after>now_at or result.cleanup_until>now_at then return null; end if;
  update dbchat_exports set cleanup_token=p_token,cleanup_until=now_at+interval '90 seconds' where id=result.id returning * into result;
  return to_jsonb(result);
end $$;

create function public.dbchat_export_cleanup_finish(p_id uuid,p_token uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare result public.dbchat_exports; now_at timestamptz;
begin
  select * into result from dbchat_exports where id=p_id for update;
  -- An unchanged row can hold this lock past the lease without forcing UPDATE
  -- predicates to run again. Validate the token and time only after the wait.
  now_at := clock_timestamp();
  if not found or p_token is null or result.cleanup_token is distinct from p_token or result.cleanup_until is null
    or result.cleanup_until<=now_at then return; end if;
  update dbchat_exports set object_deleted=true,cleanup_token=null,cleanup_until=null,
    cleanup_after=now_at+interval '10 minutes',
    tombstone_until=case when expires_at<=now_at or remove_requested then coalesce(tombstone_until,now_at+interval '24 hours') else tombstone_until end
    where id=p_id;
  if found then
    -- Retry deletion over a grace window to catch a delayed Storage upload that
    -- committed after a lost/aborted response. IDs and object keys never repeat.
    delete from dbchat_exports where id=p_id and tombstone_until<=now_at;
  end if;
end $$;

revoke all on function public.dbchat_export_create(uuid,uuid,uuid,text,jsonb,jsonb),
 public.dbchat_export_tick(uuid,uuid,boolean),public.dbchat_export_finish(uuid,uuid,text,bigint,bigint),
 public.dbchat_export_cancel(uuid,uuid,boolean),public.dbchat_export_cleanup_claim(uuid),public.dbchat_export_cleanup_finish(uuid,uuid)
 ,public.dbchat_export_stop_worker(uuid)
 from public,anon,authenticated;
grant execute on function public.dbchat_export_create(uuid,uuid,uuid,text,jsonb,jsonb),
 public.dbchat_export_tick(uuid,uuid,boolean),public.dbchat_export_finish(uuid,uuid,text,bigint,bigint),
 public.dbchat_export_cancel(uuid,uuid,boolean),public.dbchat_export_cleanup_claim(uuid),public.dbchat_export_cleanup_finish(uuid,uuid)
 ,public.dbchat_export_stop_worker(uuid)
 to service_role;
