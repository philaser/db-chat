-- Reserve managed answer allowances atomically with the accepted question.
-- Counts include failed/cancelled attempts and survive chat/account deletion.
begin;
create table public.dbchat_managed_usage (
 usage_day date not null, scope text not null, accepted_turns integer not null check(accepted_turns >= 0),
 primary key(usage_day,scope)
);
alter table public.dbchat_managed_usage enable row level security;
revoke all on public.dbchat_managed_usage from public,anon,authenticated;
grant select,insert,update,delete on public.dbchat_managed_usage to service_role;

create function public.dbchat_claim_turn_with_limits(
 owner uuid,turn_id text,chat text,request_id text,user_message jsonb,assistant_message_id text,
 managed boolean,account_daily_limit integer,global_daily_limit integer,turn_context jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare prior public.dbchat_turns; result jsonb; usage_date date := (now() at time zone 'UTC')::date;
begin
 -- Every managed claim takes the same lock first, including claims from other accounts.
 -- This makes check-and-increment safe across processes and concurrent requests.
 if managed then perform pg_advisory_xact_lock(hashtextextended('dbchat-managed-usage:' || usage_date::text,0)); end if;
 perform pg_advisory_xact_lock(hashtextextended(owner::text || ':' || request_id,0));
 select * into prior from public.dbchat_turns t where t.user_id=owner and t.request_id=dbchat_claim_turn_with_limits.request_id;
 if found then
  if prior.chat_id<>chat then raise exception 'Request belongs to another chat'; end if;
  return jsonb_build_object('turnId',prior.id,'created',false);
 end if;
 if managed then
  if account_daily_limit is null or account_daily_limit<1 or global_daily_limit is null or global_daily_limit<1 then raise exception 'Invalid managed answer allowance'; end if;
  if coalesce((select accepted_turns from public.dbchat_managed_usage where usage_day=usage_date and scope=owner::text),0)>=account_daily_limit then
   return jsonb_build_object('created',false,'quotaExceeded','account');
  end if;
  if coalesce((select accepted_turns from public.dbchat_managed_usage where usage_day=usage_date and scope='global'),0)>=global_daily_limit then
   return jsonb_build_object('created',false,'quotaExceeded','global');
  end if;
 end if;
 -- The existing claim owns tenant validation, request deduplication, the chat lock,
 -- and message identity checks. Any failure rolls back the quota reservation too.
 result := public.dbchat_claim_turn(owner,turn_id,chat,request_id,user_message,assistant_message_id);
 if (result->>'created')::boolean then
  update public.dbchat_turns set snapshot=snapshot || jsonb_strip_nulls(jsonb_build_object('attemptOf',turn_context->'attemptOf','intent',turn_context->'intent'))
   where user_id=owner and id=turn_id;
  if managed then
   insert into public.dbchat_managed_usage values(usage_date,owner::text,1),(usage_date,'global',1)
    on conflict(usage_day,scope) do update set accepted_turns=public.dbchat_managed_usage.accepted_turns+1;
  end if;
 end if;
 return result;
end $$;
revoke all on function public.dbchat_claim_turn_with_limits(uuid,text,text,text,jsonb,text,boolean,integer,integer,jsonb) from public,anon,authenticated;
grant execute on function public.dbchat_claim_turn_with_limits(uuid,text,text,text,jsonb,text,boolean,integer,integer,jsonb) to service_role;
commit;
