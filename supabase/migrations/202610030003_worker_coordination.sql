-- Initial upgrade from the unfenced binary requires a maintenance cutover.
-- Thereafter leases allow overlapping workers; old RPCs cannot bypass fencing.
begin;
create table public.dbchat_workers (
 id uuid primary key, lease_until timestamptz not null, created_at timestamptz not null default now()
);
create table public.dbchat_turn_executions (
 turn_id text primary key references public.dbchat_turns(id) on delete cascade,
 user_id uuid not null, worker_id uuid not null references public.dbchat_workers(id),
 cancel_requested boolean not null default false, execution_finished boolean not null default false
);
create index dbchat_turns_recovery on public.dbchat_turns(created_at) where not finalized;
create index dbchat_turn_executions_worker on public.dbchat_turn_executions(worker_id) where not execution_finished;
alter table public.dbchat_workers enable row level security;
alter table public.dbchat_turn_executions enable row level security;
revoke all on public.dbchat_workers,public.dbchat_turn_executions from public,anon,authenticated;
grant select,insert,update,delete on public.dbchat_workers,public.dbchat_turn_executions to service_role;

-- Keep the original transactional storage routines private to fenced wrappers.
alter function public.dbchat_save_turn(uuid,jsonb) rename to dbchat_save_turn_internal;
alter function public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb) rename to dbchat_finalize_turn_internal;
revoke all on function public.dbchat_save_turn_internal(uuid,jsonb),public.dbchat_finalize_turn_internal(uuid,jsonb,jsonb,jsonb),public.dbchat_claim_turn(uuid,text,text,text,jsonb,text),public.dbchat_claim_turn_with_limits(uuid,text,text,text,jsonb,text,boolean,integer,integer,jsonb),public.dbchat_interrupt_pending_turns() from public,anon,authenticated,service_role;
-- Compatibility for administrator-run migration checks only. Runtime callers
-- must use the fenced functions, including on rollback to an earlier release.
create function public.dbchat_save_turn(owner uuid,turn jsonb) returns void language sql security invoker set search_path='' as $$ select public.dbchat_save_turn_internal(owner,turn); $$;
create function public.dbchat_finalize_turn(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb) returns void language sql security invoker set search_path='' as $$ select public.dbchat_finalize_turn_internal(owner,turn,assistant_message,result_artifacts); $$;
revoke all on function public.dbchat_save_turn(uuid,jsonb),public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.dbchat_register_worker(worker uuid,lease_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if lease_ms<1000 or lease_ms>120000 then raise exception 'Invalid worker lease'; end if;
 insert into public.dbchat_workers(id,lease_until) values(worker,clock_timestamp()+lease_ms*interval '1 millisecond') on conflict do nothing;
 return jsonb_build_object('alive',found,'cancelledTurns','[]'::jsonb);
end $$;
create function public.dbchat_heartbeat_worker(worker uuid,lease_ms integer) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if lease_ms<1000 or lease_ms>120000 then raise exception 'Invalid worker lease'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 update public.dbchat_workers set lease_until=clock_timestamp()+lease_ms*interval '1 millisecond' where id=worker and lease_until>clock_timestamp();
 if not found then return jsonb_build_object('alive',false,'cancelledTurns','[]'::jsonb); end if;
 return jsonb_build_object('alive',true,'cancelledTurns',coalesce((select jsonb_agg(turn_id) from public.dbchat_turn_executions where worker_id=worker and cancel_requested and not execution_finished),'[]'::jsonb));
end $$;
create function public.dbchat_release_worker(worker uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 update public.dbchat_workers set lease_until=least(lease_until,clock_timestamp()) where id=worker;
end $$;
create function public.dbchat_claim_turn_coordinated(owner uuid,turn_id text,chat text,request_id text,user_message jsonb,assistant_message_id text,
 managed boolean,account_daily_limit integer,global_daily_limit integer,turn_context jsonb,worker uuid,account_active_limit integer,global_active_limit integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; prior public.dbchat_turns;
begin
 -- Defined by 004; all migrations must be installed before this binary starts.
 perform public.dbchat_assert_account_active(owner);
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 if not exists(select 1 from public.dbchat_workers where id=worker and lease_until>clock_timestamp()) then return jsonb_build_object('leaseLost',true); end if;
 select * into prior from public.dbchat_turns t where t.user_id=owner and t.request_id=dbchat_claim_turn_coordinated.request_id;
 if found then
  if prior.chat_id<>chat then raise exception 'Request belongs to another chat'; end if;
  return jsonb_build_object('turnId',prior.id,'created',false);
 end if;
 if account_active_limit<1 or global_active_limit<1 then raise exception 'Invalid active turn limit'; end if;
 if (select count(*) from public.dbchat_turn_executions e join public.dbchat_workers w on w.id=e.worker_id where not e.execution_finished and w.lease_until>clock_timestamp() and e.user_id=owner)>=account_active_limit
  or (select count(*) from public.dbchat_turn_executions e join public.dbchat_workers w on w.id=e.worker_id where not e.execution_finished and w.lease_until>clock_timestamp())>=global_active_limit then
  return jsonb_build_object('capacityExceeded',true);
 end if;
 result:=public.dbchat_claim_turn_with_limits(owner,turn_id,chat,request_id,user_message,assistant_message_id,managed,account_daily_limit,global_daily_limit,turn_context);
 if (result->>'created')::boolean then insert into public.dbchat_turn_executions(turn_id,user_id,worker_id) values(turn_id,owner,worker); end if;
 return result;
end $$;
create function public.dbchat_save_turn_fenced(owner uuid,turn jsonb,worker uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 if not exists(select 1 from public.dbchat_turn_executions e join public.dbchat_workers w on w.id=e.worker_id where e.turn_id=turn->>'id' and e.user_id=owner and e.worker_id=worker and not e.execution_finished and w.lease_until>clock_timestamp()) then raise exception 'DBCHAT_WORKER_FENCED'; end if;
 if exists(select 1 from public.dbchat_account_deletions where dbchat_account_deletions.owner=dbchat_save_turn_fenced.owner) then return; end if;
 -- Leave room for a terminal error and the 16 MiB repository response envelope.
 if octet_length(turn::text)>14680064 then raise exception 'DBCHAT_SAVED_READ_LIMIT'; end if;
 perform public.dbchat_save_turn_internal(owner,turn);
end $$;
create function public.dbchat_finalize_turn_fenced(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb,worker uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare execution public.dbchat_turn_executions; stored public.dbchat_turns; saved_flag text; terminal_flag text; stop_message text; event_id bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 select * into execution from public.dbchat_turn_executions where turn_id=turn->>'id' and user_id=owner and worker_id=worker;
 if not found or not exists(select 1 from public.dbchat_workers where id=worker and lease_until>clock_timestamp()) then raise exception 'DBCHAT_WORKER_FENCED'; end if;
 select * into stored from public.dbchat_turns where id=execution.turn_id and user_id=owner;
 if stored.finalized then return stored.snapshot; end if;
 if execution.execution_finished then raise exception 'DBCHAT_WORKER_FENCED'; end if;
 if execution.cancel_requested or exists(select 1 from public.dbchat_account_deletions where dbchat_account_deletions.owner=dbchat_finalize_turn_fenced.owner) then
  stop_message:='Answer stopped.';
  select coalesce(max((event->>'id')::bigint),0)+1 into event_id from jsonb_array_elements(coalesce(stored.snapshot->'events','[]'::jsonb)) event;
  assistant_message:=jsonb_strip_nulls(jsonb_build_object('metrics',assistant_message->'metrics'))||jsonb_build_object('id',stored.assistant_message_id,'role','assistant','content',stop_message,'createdAt',clock_timestamp(),'turn',jsonb_build_object('id',stored.id,'status','aborted','question',stored.snapshot->>'question','attemptOf',stored.snapshot->'attemptOf','intent',stored.snapshot->'intent'));
  result_artifacts:='[]'::jsonb;
  turn:=turn||jsonb_build_object('status','aborted','message',assistant_message,'artifacts',result_artifacts,'error',stop_message,'events',coalesce(stored.snapshot->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',event_id,'turnId',stored.id,'type','aborted','timestamp',clock_timestamp(),'data',jsonb_build_object('message',stop_message))));
 end if;
 saved_flag:=current_setting('dbchat.retention_finalizing',true); terminal_flag:=current_setting('dbchat.terminal_finalize',true);
 perform set_config('dbchat.retention_finalizing',owner::text||':'||stored.id,true); perform set_config('dbchat.terminal_finalize','true',true);
 perform public.dbchat_finalize_turn_internal(owner,turn,assistant_message,result_artifacts);
 perform set_config('dbchat.retention_finalizing',coalesce(saved_flag,''),true); perform set_config('dbchat.terminal_finalize',coalesce(terminal_flag,''),true);
 update public.dbchat_turn_executions set execution_finished=true where turn_id=stored.id;
 return (select snapshot from public.dbchat_turns where id=stored.id);
end $$;
create function public.dbchat_finish_turn_execution(owner uuid,turn_id text,worker uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 update public.dbchat_turn_executions e set execution_finished=true where e.turn_id=dbchat_finish_turn_execution.turn_id and e.user_id=owner and e.worker_id=worker;
end $$;
create function public.dbchat_cancel_turn(owner uuid,turn_id text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 update public.dbchat_turn_executions e set cancel_requested=true where e.turn_id=dbchat_cancel_turn.turn_id and e.user_id=owner and not e.execution_finished;
 return exists(select 1 from public.dbchat_turns t where t.id=turn_id and t.user_id=owner);
end $$;
create function public.dbchat_cancel_owner_turns(owner uuid) returns integer
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 update public.dbchat_turn_executions set cancel_requested=true where user_id=owner and not execution_finished;
 return (select count(*)::integer from public.dbchat_turn_executions e join public.dbchat_workers w on w.id=e.worker_id where e.user_id=owner and not e.execution_finished and w.lease_until>clock_timestamp());
end $$;
create function public.dbchat_recoverable_turns() returns table(owner uuid,turn_id text)
language plpgsql security definer set search_path='' as $$
begin
 -- Worker-only metadata can be pruned after a grace period. Any execution
 -- reference keeps its worker record; customer turns are never age-deleted.
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 delete from public.dbchat_workers where id in (
  select w.id from public.dbchat_workers w where w.lease_until<clock_timestamp()-interval '24 hours'
   and not exists(select 1 from public.dbchat_turn_executions e where e.worker_id=w.id)
  order by w.lease_until limit 100);
 return query select t.user_id,t.id from public.dbchat_turns t left join public.dbchat_turn_executions e on e.turn_id=t.id left join public.dbchat_workers w on w.id=e.worker_id
 where not t.finalized and (e.turn_id is null or e.execution_finished or w.lease_until<=clock_timestamp()) order by t.created_at limit 100;
end $$;
create function public.dbchat_recover_turn(owner uuid,turn_id text) returns boolean
language plpgsql security definer set search_path='' as $$
declare stored public.dbchat_turns; snapshot jsonb; saved_flag text; terminal_flag text; event_id bigint;
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 perform pg_advisory_xact_lock(hashtextextended('dbchat-turn-coordination',0));
 select * into stored from public.dbchat_turns t where t.id=turn_id and t.user_id=owner and not t.finalized;
 if not found then return false; end if;
 if exists(select 1 from public.dbchat_turn_executions e join public.dbchat_workers w on w.id=e.worker_id where e.turn_id=stored.id and not e.execution_finished and w.lease_until>clock_timestamp()) then return false; end if;
 select coalesce(max((event->>'id')::bigint),0)+1 into event_id from jsonb_array_elements(coalesce(stored.snapshot->'events','[]'::jsonb)) event;
 snapshot:=stored.snapshot||jsonb_build_object('status','error','error','The answer worker stopped before this answer finished. Please retry.','events',coalesce(stored.snapshot->'events','[]'::jsonb)||jsonb_build_array(jsonb_build_object('id',event_id,'turnId',stored.id,'type','error','timestamp',clock_timestamp(),'data',jsonb_build_object('message','The answer worker stopped before this answer finished. Please retry.'))));
 saved_flag:=current_setting('dbchat.retention_finalizing',true); terminal_flag:=current_setting('dbchat.terminal_finalize',true);
 perform set_config('dbchat.retention_finalizing',owner::text||':'||stored.id,true); perform set_config('dbchat.terminal_finalize','true',true);
 perform public.dbchat_finalize_turn_internal(owner,snapshot,null,coalesce(stored.snapshot->'artifacts','[]'::jsonb));
 perform set_config('dbchat.retention_finalizing',coalesce(saved_flag,''),true); perform set_config('dbchat.terminal_finalize',coalesce(terminal_flag,''),true);
 update public.dbchat_turn_executions set execution_finished=true where dbchat_turn_executions.turn_id=stored.id;
 return true;
end $$;
-- Grant only the owner-bearing, fenced API. Every function runs with an empty search_path.
do $$ declare fn regprocedure; begin
 for fn in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('dbchat_register_worker','dbchat_heartbeat_worker','dbchat_release_worker','dbchat_claim_turn_coordinated','dbchat_save_turn_fenced','dbchat_finalize_turn_fenced','dbchat_finish_turn_execution','dbchat_cancel_turn','dbchat_cancel_owner_turns','dbchat_recoverable_turns','dbchat_recover_turn') loop
  execute format('revoke all on function %s from public,anon,authenticated',fn);
  execute format('grant execute on function %s to service_role',fn);
 end loop;
end $$;
commit;
