-- Keep saved content. Admission limits growth; accepted turns retain bounded
-- completion headroom. These are logical JSON bytes, not PostgreSQL disk bytes.
begin;

create table public.dbchat_retention_policy (
 scope text primary key check(scope='project' or scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 max_connections integer not null default 100 check(max_connections>=0),
 max_chats integer not null default 1000 check(max_chats>=0),
 max_messages integer not null default 100000 check(max_messages>=0),
 max_artifacts integer not null default 100000 check(max_artifacts>=0),
 max_sessions integer not null default 20 check(max_sessions>=1),
 max_recovery_sessions integer not null default 2 check(max_recovery_sessions>=1),
 max_retained_bytes bigint not null default 104857600 check(max_retained_bytes>0),
 retained_sqlite_bytes bigint not null default 1073741824 check(retained_sqlite_bytes>0),
 turn_reserve_bytes bigint not null default 16777216 check(turn_reserve_bytes between 65536 and 67108864),
 turn_reserve_artifacts integer not null default 8 check(turn_reserve_artifacts between 0 and 128)
);
insert into public.dbchat_retention_policy(scope) values('project');

create table public.dbchat_retained_usage (
 user_id uuid primary key,
 connection_count bigint not null default 0 check(connection_count>=0),
 chat_count bigint not null default 0 check(chat_count>=0),
 message_count bigint not null default 0 check(message_count>=0),
 artifact_count bigint not null default 0 check(artifact_count>=0),
 retained_bytes bigint not null default 0 check(retained_bytes>=0),
 reserved_bytes bigint not null default 0 check(reserved_bytes>=0),
 reserved_messages bigint not null default 0 check(reserved_messages>=0),
 reserved_artifacts bigint not null default 0 check(reserved_artifacts>=0)
);
create table public.dbchat_retention_reservations (
 user_id uuid not null, turn_id text primary key,
 reserved_bytes bigint not null, reserved_messages integer not null, reserved_artifacts integer not null
);
-- A caller setting a custom GUC cannot forge this authorization. Only the
-- private finalization helper creates it after fenced callers validate a turn.
create table public.dbchat_retention_finalizers (
 backend_pid integer not null, transaction_id bigint not null,
 user_id uuid not null, turn_id text not null, chat_id text, assistant_message_id text,
 added_bytes bigint not null default 0, message_rows integer not null default 0, artifact_rows integer not null default 0,
 primary key(backend_pid,transaction_id)
);

alter table public.dbchat_retention_policy enable row level security;
alter table public.dbchat_retained_usage enable row level security;
alter table public.dbchat_retention_reservations enable row level security;
alter table public.dbchat_retention_finalizers enable row level security;
revoke all on public.dbchat_retention_policy,public.dbchat_retained_usage,public.dbchat_retention_reservations,public.dbchat_retention_finalizers from public,anon,authenticated,service_role;
grant select,insert,update,delete on public.dbchat_retention_policy to service_role;
grant select on public.dbchat_retained_usage,public.dbchat_retention_reservations to service_role;

create function public.dbchat_effective_retention_policy(owner uuid)
returns public.dbchat_retention_policy language plpgsql stable security definer set search_path='' as $$
declare policy public.dbchat_retention_policy;
begin
 select * into policy from public.dbchat_retention_policy where scope in ('project',owner::text) order by (scope='project') limit 1;
 if not found then raise exception 'DBCHAT_RETENTION_POLICY_MISSING'; end if;
 return policy;
end $$;
create function public.dbchat_retained_sqlite_limit(owner uuid) returns bigint
language sql stable security definer set search_path='' as $$
 select (public.dbchat_effective_retention_policy(owner)).retained_sqlite_bytes;
$$;
revoke all on function public.dbchat_effective_retention_policy(uuid),public.dbchat_retained_sqlite_limit(uuid) from public,anon,authenticated;
grant execute on function public.dbchat_effective_retention_policy(uuid),public.dbchat_retained_sqlite_limit(uuid) to service_role;

-- DDL locks prevent writes while the initial ledger is computed. Existing
-- over-limit records and active turns are retained, never trimmed or removed.
lock table public.dbchat_profiles,public.dbchat_connections,public.dbchat_chats,public.dbchat_messages,public.dbchat_artifacts,public.dbchat_turns,public.dbchat_connection_knowledge in share row exclusive mode;
insert into public.dbchat_retained_usage(user_id,connection_count,chat_count,message_count,artifact_count,retained_bytes)
select user_id,count(*) filter(where kind='connection'),count(*) filter(where kind='chat'),
 count(*) filter(where kind='message'),count(*) filter(where kind='artifact'),sum(bytes)
from (
 select user_id,'profile' as kind,octet_length(to_jsonb(t)::text)::bigint as bytes from public.dbchat_profiles t
 union all select user_id,'connection',octet_length(to_jsonb(t)::text) from public.dbchat_connections t
 union all select user_id,'chat',octet_length(to_jsonb(t)::text) from public.dbchat_chats t
 union all select user_id,'message',octet_length(to_jsonb(t)::text) from public.dbchat_messages t
 union all select user_id,'artifact',octet_length(to_jsonb(t)::text) from public.dbchat_artifacts t
 union all select user_id,'turn',octet_length(to_jsonb(t)::text) from public.dbchat_turns t
 union all select user_id,'knowledge',octet_length(to_jsonb(t)::text) from public.dbchat_connection_knowledge t
) records group by user_id;
insert into public.dbchat_retention_reservations(user_id,turn_id,reserved_bytes,reserved_messages,reserved_artifacts)
select user_id,id,(public.dbchat_effective_retention_policy(user_id)).turn_reserve_bytes,1,
 (public.dbchat_effective_retention_policy(user_id)).turn_reserve_artifacts from public.dbchat_turns where not finalized;
update public.dbchat_retained_usage u set reserved_bytes=r.bytes,reserved_messages=r.messages,reserved_artifacts=r.artifacts
from (select user_id,sum(reserved_bytes) bytes,sum(reserved_messages) messages,sum(reserved_artifacts) artifacts
 from public.dbchat_retention_reservations group by user_id) r where r.user_id=u.user_id;

create function public.dbchat_account_retained_write() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_doc jsonb; new_doc jsonb; owner uuid; policy public.dbchat_retention_policy;
 usage public.dbchat_retained_usage; reservation public.dbchat_retention_reservations;
 finalizer public.dbchat_retention_finalizers; completion boolean:=false; unlink boolean:=false;
 delta_rows integer:=0; delta_bytes bigint:=0; dc integer:=0; dh integer:=0; dm integer:=0; da integer:=0;
 rb bigint:=0; rm integer:=0; ra integer:=0;
begin
 if tg_op<>'INSERT' then old_doc:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then new_doc:=to_jsonb(new); end if;
 owner:=coalesce((new_doc->>'user_id')::uuid,(old_doc->>'user_id')::uuid);
 if tg_op='UPDATE' and new_doc->>'user_id' is distinct from old_doc->>'user_id' then raise exception 'Record owner cannot change'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 if tg_table_name='dbchat_profiles' and tg_op='DELETE' then
  delete from public.dbchat_retention_reservations where user_id=owner;
  delete from public.dbchat_retained_usage where user_id=owner;
  delete from public.dbchat_retention_policy where scope=owner::text;
  return null;
 end if;
 -- Account cascades can run after the profile has gone. Their ledger is removed
 -- by the profile trigger; recreating it here would leave ownerless usage rows.
 if not exists(select 1 from public.dbchat_profiles where user_id=owner) then return null; end if;
 policy:=public.dbchat_effective_retention_policy(owner);
 insert into public.dbchat_retained_usage(user_id) values(owner) on conflict do nothing;
 select * into usage from public.dbchat_retained_usage where user_id=owner for update;
 delta_rows:=case tg_op when 'INSERT' then 1 when 'DELETE' then -1 else 0 end;
 delta_bytes:=coalesce(octet_length(new_doc::text),0)-coalesce(octet_length(old_doc::text),0);
 dc:=case when tg_table_name='dbchat_connections' then delta_rows else 0 end;
 dh:=case when tg_table_name='dbchat_chats' then delta_rows else 0 end;
 dm:=case when tg_table_name='dbchat_messages' then delta_rows else 0 end;
 da:=case when tg_table_name='dbchat_artifacts' then delta_rows else 0 end;

 select * into finalizer from public.dbchat_retention_finalizers
  where backend_pid=pg_backend_pid() and transaction_id=txid_current() and user_id=owner;
 if found and exists(select 1 from public.dbchat_retention_reservations where user_id=owner and turn_id=finalizer.turn_id) then
  completion:=
   (tg_table_name='dbchat_messages' and tg_op='INSERT' and new_doc->>'chat_id'=finalizer.chat_id
    and new_doc->'body'->>'role'='assistant' and new_doc->'body'->>'id'=finalizer.assistant_message_id)
   or (tg_table_name='dbchat_artifacts' and tg_op='INSERT' and new_doc->>'chat_id'=finalizer.chat_id
    and new_doc->'body'->>'messageId'=finalizer.assistant_message_id)
   or (tg_table_name='dbchat_chats' and tg_op='UPDATE' and new_doc->>'id'=finalizer.chat_id
    and (new_doc-array['updated_at','message_count','artifact_count'])=(old_doc-array['updated_at','message_count','artifact_count']))
   or (tg_table_name='dbchat_turns' and tg_op='UPDATE' and new_doc->>'id'=finalizer.turn_id
    and old_doc->>'finalized'='false' and new_doc->>'finalized'='true'
    and new_doc->'snapshot'->>'status' in ('complete','error','aborted'));
 end if;
 if completion then
  update public.dbchat_retention_finalizers set added_bytes=added_bytes+greatest(delta_bytes,0),
   message_rows=message_rows+greatest(dm,0),artifact_rows=artifact_rows+greatest(da,0)
   where backend_pid=pg_backend_pid() and transaction_id=txid_current() returning * into finalizer;
  if finalizer.added_bytes>67108864 or finalizer.message_rows>1 or finalizer.artifact_rows>128 then
   raise exception 'DBCHAT_RETENTION_COMPLETION_LIMIT';
  end if;
 end if;

 if tg_table_name='dbchat_turns' then
  if tg_op='UPDATE' and old_doc->>'finalized'='true' and new_doc->>'finalized'='false' then raise exception 'Finalized turn cannot be reopened'; end if;
  if tg_op='INSERT' and new_doc->>'finalized'='false' then
   rb:=policy.turn_reserve_bytes; rm:=1; ra:=policy.turn_reserve_artifacts;
   insert into public.dbchat_retention_reservations values(owner,new_doc->>'id',rb,rm,ra);
  elsif tg_op='DELETE' or (tg_op='UPDATE' and new_doc->>'finalized'='true') then
   delete from public.dbchat_retention_reservations where user_id=owner and turn_id=old_doc->>'id' returning * into reservation;
   if found then rb:=-reservation.reserved_bytes; rm:=-reservation.reserved_messages; ra:=-reservation.reserved_artifacts; end if;
  end if;
 end if;
 -- A connection deletion may set the chat's FK to null, which can be a few
 -- bytes longer than a short identifier. Never block that removal at capacity.
 unlink:=tg_table_name='dbchat_chats' and tg_op='UPDATE' and old_doc->>'connection_id' is not null
  and new_doc->>'connection_id' is null and new_doc-'connection_id'=old_doc-'connection_id';
 if tg_op<>'DELETE' and not completion and not unlink then
  if (dc>0 and usage.connection_count+dc>policy.max_connections)
   or (dh>0 and usage.chat_count+dh>policy.max_chats)
   or (dm+rm>0 and usage.message_count+usage.reserved_messages+dm+rm>policy.max_messages)
   or (da+ra>0 and usage.artifact_count+usage.reserved_artifacts+da+ra>policy.max_artifacts)
   or (delta_bytes+rb>0 and usage.retained_bytes+usage.reserved_bytes+delta_bytes+rb>policy.max_retained_bytes) then
   raise exception 'DBCHAT_RETENTION_LIMIT';
  end if;
 end if;
 update public.dbchat_retained_usage set connection_count=connection_count+dc,chat_count=chat_count+dh,
  message_count=message_count+dm,artifact_count=artifact_count+da,retained_bytes=retained_bytes+delta_bytes,
  reserved_bytes=reserved_bytes+rb,reserved_messages=reserved_messages+rm,reserved_artifacts=reserved_artifacts+ra
  where user_id=owner;
 return null;
end $$;
revoke all on function public.dbchat_account_retained_write() from public,anon,authenticated,service_role;

create trigger dbchat_retained_profile after insert or update or delete on public.dbchat_profiles for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_connection after insert or update or delete on public.dbchat_connections for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_chat after insert or update or delete on public.dbchat_chats for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_message after insert or update or delete on public.dbchat_messages for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_artifact after insert or update or delete on public.dbchat_artifacts for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_turn after insert or update or delete on public.dbchat_turns for each row execute function public.dbchat_account_retained_write();
create trigger dbchat_retained_knowledge after insert or update or delete on public.dbchat_connection_knowledge for each row execute function public.dbchat_account_retained_write();

create function public.dbchat_bound_sessions() returns trigger
language plpgsql security definer set search_path='' as $$
declare policy public.dbchat_retention_policy; maximum integer; current_ms bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||new.user_id::text,0));
 current_ms:=floor(extract(epoch from clock_timestamp())*1000);
 if tg_op='INSERT' then
  -- A refresh can already hold its session row while waiting for the owner
  -- lock. Skip that row rather than invert the lock order during admission.
  delete from public.dbchat_sessions where id_hash in (
   select id_hash from public.dbchat_sessions where user_id=new.user_id
    and (expires_at<=current_ms or absolute_expires_at<=current_ms) for update skip locked);
 elsif old.user_id<>new.user_id then raise exception 'Session owner cannot change';
 elsif old.purpose=new.purpose and old.expires_at>current_ms and old.absolute_expires_at>current_ms then
  return new; -- Existing live sessions may refresh, even after a policy reduction.
 end if;
 policy:=public.dbchat_effective_retention_policy(new.user_id);
 maximum:=case when new.purpose='recovery' then policy.max_recovery_sessions else policy.max_sessions end;
 if new.expires_at>current_ms and new.absolute_expires_at>current_ms and
  (select count(*) from public.dbchat_sessions where user_id=new.user_id and purpose=new.purpose
    and id_hash<>new.id_hash and expires_at>current_ms and absolute_expires_at>current_ms)>=maximum then
  raise exception 'DBCHAT_SESSION_LIMIT';
 end if;
 return new;
end $$;
revoke all on function public.dbchat_bound_sessions() from public,anon,authenticated,service_role;
create trigger dbchat_session_capacity before insert or update on public.dbchat_sessions for each row execute function public.dbchat_bound_sessions();

-- Acquire the owner lock before any existing row lock. Row-level triggers alone
-- cannot prevent an UPDATE/DELETE versus coordinated-claim lock inversion.
alter function public.dbchat_update_chat(uuid,text,jsonb) rename to dbchat_update_chat_storage_base;
alter function public.dbchat_update_message_metadata(uuid,text,text,jsonb) rename to dbchat_update_message_metadata_storage_base;
revoke all on function public.dbchat_update_chat_storage_base(uuid,text,jsonb),public.dbchat_update_message_metadata_storage_base(uuid,text,text,jsonb) from public,anon,authenticated,service_role;
create function public.dbchat_update_chat(owner uuid,chat text,changes jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.dbchat_assert_account_active(owner);
 perform public.dbchat_update_chat_storage_base(owner,chat,changes);
end $$;
create function public.dbchat_update_message_metadata(owner uuid,chat text,message_id text,changes jsonb) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform public.dbchat_assert_account_active(owner);
 perform public.dbchat_update_message_metadata_storage_base(owner,chat,message_id,changes);
end $$;
create function public.dbchat_delete_chat(owner uuid,chat text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform public.dbchat_assert_account_active(owner);
 delete from public.dbchat_chats where user_id=owner and id=chat;
 return found;
end $$;
revoke all on function public.dbchat_update_chat(uuid,text,jsonb),public.dbchat_update_message_metadata(uuid,text,text,jsonb),public.dbchat_delete_chat(uuid,text) from public,anon,authenticated;
grant execute on function public.dbchat_update_chat(uuid,text,jsonb),public.dbchat_update_message_metadata(uuid,text,text,jsonb),public.dbchat_delete_chat(uuid,text) to service_role;

-- 003's fenced/recovery wrappers call this private helper and return the actual
-- stored snapshot. A capacity error must still leave an accepted turn terminal.
alter function public.dbchat_finalize_turn_internal(uuid,jsonb,jsonb,jsonb) rename to dbchat_finalize_turn_storage_base;
create function public.dbchat_finalize_turn_internal(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare stored public.dbchat_turns; stopped_message jsonb; event_id bigint;
 stop_reason text:='The answer exceeded the saved-data completion limit. Previously saved content was kept. Reduce the requested output and try again.';
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 select * into stored from public.dbchat_turns where user_id=owner and id=turn->>'id' for update;
 if not found then raise exception 'Turn not found'; end if;
 if stored.finalized then return; end if;
 if current_setting('dbchat.retention_finalizing',true) is distinct from owner::text||':'||stored.id then
  raise exception 'Fenced finalization is required';
 end if;
 insert into public.dbchat_retention_finalizers(backend_pid,transaction_id,user_id,turn_id,chat_id,assistant_message_id)
  values(pg_backend_pid(),txid_current(),owner,stored.id,stored.chat_id,stored.assistant_message_id);
 begin
  if octet_length(turn::text)>15728640
   or coalesce(octet_length(turn::text),0)+coalesce(octet_length(assistant_message::text),0)+coalesce(octet_length(result_artifacts::text),0)>67108864
   or jsonb_array_length(coalesce(result_artifacts,'[]'::jsonb))>128 then raise exception 'DBCHAT_RETENTION_COMPLETION_LIMIT'; end if;
  perform public.dbchat_finalize_turn_storage_base(owner,turn,assistant_message,result_artifacts);
  -- The base helper can synthesize an error message. Check the actual snapshot
  -- inside this subtransaction so an oversized result rolls back before fallback.
  if (select octet_length(snapshot::text)>15728640 from public.dbchat_turns where user_id=owner and id=stored.id) then
   raise exception 'DBCHAT_RETENTION_COMPLETION_LIMIT';
  end if;
 exception when raise_exception then
  if sqlerrm<>'DBCHAT_RETENTION_COMPLETION_LIMIT' then raise; end if;
  -- Preserve the already-saved snapshot/evidence. Do not copy a rejected large
  -- incoming result into messages/artifacts or silently report it as complete.
  select coalesce(max((event->>'id')::bigint),0)+1 into event_id
   from jsonb_array_elements(coalesce(stored.snapshot->'events','[]'::jsonb)) event;
  turn:=stored.snapshot||jsonb_build_object('id',stored.id,'status','error','error',stop_reason,
   'events',coalesce(stored.snapshot->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object(
    'id',event_id,'turnId',stored.id,'type','error','timestamp',clock_timestamp(),'data',jsonb_build_object('message',stop_reason))));
  stopped_message:=jsonb_build_object('id',stored.assistant_message_id,'role','assistant','content',stop_reason,'createdAt',now(),
   'turn',jsonb_build_object('id',stored.id,'status','error','question',left(stored.snapshot->>'question',8000)));
  if stored.snapshot ? 'message' then turn:=turn||jsonb_build_object('retainedMessage',stored.snapshot->'message'); end if;
  turn:=turn||jsonb_build_object('message',stopped_message);
  perform public.dbchat_finalize_turn_storage_base(owner,turn,stopped_message,'[]'::jsonb);
 end;
 delete from public.dbchat_retention_finalizers where backend_pid=pg_backend_pid() and transaction_id=txid_current();
end $$;
revoke all on function public.dbchat_finalize_turn_internal(uuid,jsonb,jsonb,jsonb),public.dbchat_finalize_turn_storage_base(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

-- Administrator-only compatibility for the maintained migration fixture. The
-- service role remains unable to call this unfenced entry point.
create or replace function public.dbchat_finalize_turn(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare saved_flag text; terminal_flag text;
begin
 saved_flag:=current_setting('dbchat.retention_finalizing',true); terminal_flag:=current_setting('dbchat.terminal_finalize',true);
 perform set_config('dbchat.retention_finalizing',owner::text||':'||(turn->>'id'),true);
 perform set_config('dbchat.terminal_finalize','true',true);
 perform public.dbchat_finalize_turn_internal(owner,turn,assistant_message,result_artifacts);
 perform set_config('dbchat.retention_finalizing',coalesce(saved_flag,''),true);
 perform set_config('dbchat.terminal_finalize',coalesce(terminal_flag,''),true);
end $$;
revoke all on function public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.dbchat_prune_expired_sessions() returns integer
language plpgsql security invoker set search_path='' as $$
declare removed integer;
begin
 delete from public.dbchat_sessions where expires_at<=extract(epoch from clock_timestamp())*1000
  or absolute_expires_at<=extract(epoch from clock_timestamp())*1000;
 get diagnostics removed=row_count;
 return removed;
end $$;
revoke all on function public.dbchat_prune_expired_sessions() from public,anon,authenticated;
grant execute on function public.dbchat_prune_expired_sessions() to service_role;
create or replace function public.dbchat_prune_usage() returns void
language sql security invoker set search_path='' as $$
 delete from public.dbchat_managed_usage where usage_day<(now() at time zone 'UTC')::date-1;
 delete from public.dbchat_upload_usage where usage_day<(now() at time zone 'UTC')::date-1;
 select public.dbchat_prune_expired_sessions();
$$;

comment on table public.dbchat_retention_policy is 'Service-only full-row overrides keyed by project or account UUID. Saved data is never age-deleted. New turns reserve 16 MiB/one message/eight artifacts by default; already accepted fenced completions may exceed account admission capacity, with at most 64 MiB new logical JSON bytes, one message and 128 artifacts. Actual bytes remain counted and block subsequent growth. SQLite bytes are enforced by the durable asset registry. Login sessions default to 20 live per account, with two separate recovery slots; expired sessions are pruned before admission and live sessions are never evicted.';
comment on table public.dbchat_retained_usage is 'UTF-8 JSON row bytes across profiles, connections, chats, messages, artifacts, turn snapshots and knowledge, excluding database/index overhead and ephemeral sessions. Deletion/shrinking releases capacity; existing over-limit data is retained.';
commit;
