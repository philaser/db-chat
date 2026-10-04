-- Upload attempts reserve bytes before the server reads the body. Failed uploads
-- are charged too; chunked requests reserve the maximum allowed file size.
begin;
create table public.dbchat_upload_usage (
 usage_day date not null, scope text not null,
 accepted_uploads integer not null check(accepted_uploads>=0), reserved_bytes bigint not null check(reserved_bytes>=0),
 primary key(usage_day,scope)
);
alter table public.dbchat_upload_usage enable row level security;
revoke all on public.dbchat_upload_usage from public,anon,authenticated;
grant select,insert,update,delete on public.dbchat_upload_usage to service_role;

create function public.dbchat_reserve_upload(owner uuid,upload_bytes bigint,account_count_limit integer,global_count_limit integer,account_bytes_limit bigint,global_bytes_limit bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare usage_date date := (now() at time zone 'UTC')::date; account_usage public.dbchat_upload_usage; global_usage public.dbchat_upload_usage;
begin
 if upload_bytes is null or upload_bytes<1 or account_count_limit is null or account_count_limit<1 or global_count_limit is null or global_count_limit<1
  or account_bytes_limit is null or account_bytes_limit<1 or global_bytes_limit is null or global_bytes_limit<1 then raise exception 'Invalid upload allowance'; end if;
 perform 1 from public.dbchat_profiles where user_id=owner;
 if not found then raise exception 'Account not found'; end if;
 perform pg_advisory_xact_lock(hashtextextended('dbchat-upload-usage:' || usage_date::text,0));
 select * into account_usage from public.dbchat_upload_usage where usage_day=usage_date and scope=owner::text;
 select * into global_usage from public.dbchat_upload_usage where usage_day=usage_date and scope='global';
 if coalesce(account_usage.accepted_uploads,0)>=account_count_limit or coalesce(global_usage.accepted_uploads,0)>=global_count_limit
  or coalesce(account_usage.reserved_bytes,0)+upload_bytes>account_bytes_limit or coalesce(global_usage.reserved_bytes,0)+upload_bytes>global_bytes_limit then
  return jsonb_build_object('accepted',false);
 end if;
 insert into public.dbchat_upload_usage values(usage_date,owner::text,1,upload_bytes),(usage_date,'global',1,upload_bytes)
  on conflict(usage_day,scope) do update set accepted_uploads=public.dbchat_upload_usage.accepted_uploads+1,reserved_bytes=public.dbchat_upload_usage.reserved_bytes+excluded.reserved_bytes;
 return jsonb_build_object('accepted',true);
end $$;
revoke all on function public.dbchat_reserve_upload(uuid,bigint,integer,integer,bigint,bigint) from public,anon,authenticated;
grant execute on function public.dbchat_reserve_upload(uuid,bigint,integer,integer,bigint,bigint) to service_role;

-- The server invokes pruning at startup and hourly. Retain today and yesterday;
-- aggregate abuse counters deliberately have no account FK, so deletion cannot
-- erase the current day's platform consumption. No prompts or file data live here.
create function public.dbchat_prune_usage() returns void
language sql security invoker set search_path='' as $$
 delete from public.dbchat_managed_usage where usage_day<(now() at time zone 'UTC')::date-1;
 delete from public.dbchat_upload_usage where usage_day<(now() at time zone 'UTC')::date-1;
$$;
revoke all on function public.dbchat_prune_usage() from public,anon,authenticated;
grant execute on function public.dbchat_prune_usage() to service_role;
commit;
