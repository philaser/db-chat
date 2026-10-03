-- Durable, backend-only ownership of uploaded SQLite objects and account erasure.
-- Neither table cascades from Auth: cleanup must survive deletion and lost replies.
begin;
create table public.dbchat_sqlite_assets (
 id uuid primary key, owner uuid not null, object_key text not null unique,
 file_name text not null, bytes bigint not null check(bytes>=0),
 state text not null check(state in ('uploading','pending','attached','deleting','deleted')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 upload_lease_until timestamptz, expires_at timestamptz,
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default clock_timestamp(),
 attempts integer not null default 0, deleted_at timestamptz
);
create index dbchat_assets_owner on public.dbchat_sqlite_assets(owner,state);
create index dbchat_assets_cleanup on public.dbchat_sqlite_assets(state,next_attempt_at);
create table public.dbchat_account_deletions (
 owner uuid primary key, phase text not null default 'waiting' check(phase in ('waiting','storage','auth','complete')),
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 lease_token uuid, lease_until timestamptz, next_attempt_at timestamptz not null default clock_timestamp(),
 attempts integer not null default 0, completed_at timestamptz
);
alter table public.dbchat_sqlite_assets enable row level security;
alter table public.dbchat_account_deletions enable row level security;
revoke all on public.dbchat_sqlite_assets,public.dbchat_account_deletions from public,anon,authenticated;
grant select,insert,update,delete on public.dbchat_sqlite_assets,public.dbchat_account_deletions to service_role;

create function public.dbchat_assert_account_active(owner uuid) returns void
language plpgsql security invoker set search_path='' as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 if exists(select 1 from public.dbchat_account_deletions d where d.owner=dbchat_assert_account_active.owner) then
  raise exception 'Account deletion in progress';
 end if;
end $$;

create function public.dbchat_asset_limit(owner uuid) returns bigint
language plpgsql security invoker set search_path='' as $$
declare maximum bigint:=1073741824;
begin
 -- Retention policy is introduced in migration 005; keep 004 independently safe.
 if to_regprocedure('public.dbchat_retained_sqlite_limit(uuid)') is not null then
  execute 'select public.dbchat_retained_sqlite_limit($1)' into maximum using owner;
 end if;
 return maximum;
end $$;

create function public.dbchat_begin_sqlite_upload(owner uuid,asset_id uuid,file_name text,upload_bytes bigint)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare asset public.dbchat_sqlite_assets; used bigint; maximum bigint;
begin
 perform public.dbchat_assert_account_active(owner);
 if not exists(select 1 from public.dbchat_profiles where user_id=owner) then raise exception 'Account not found'; end if;
 if upload_bytes is null or upload_bytes<16 or upload_bytes>2147483647 or file_name is null or length(file_name)<1 or length(file_name)>255 then raise exception 'Invalid SQLite upload'; end if;
 select * into asset from public.dbchat_sqlite_assets where id=asset_id;
 if found then
  if asset.owner<>owner or asset.bytes<>upload_bytes or asset.file_name<>file_name then raise exception 'Upload identity conflict'; end if;
  return jsonb_build_object('accepted',true,'asset',to_jsonb(asset));
 end if;
 select coalesce(sum(bytes),0) into used from public.dbchat_sqlite_assets a where a.owner=dbchat_begin_sqlite_upload.owner and state<>'deleted';
 maximum:=public.dbchat_asset_limit(owner);
 if used+upload_bytes>maximum then return jsonb_build_object('accepted',false,'reason','retained_bytes'); end if;
 insert into public.dbchat_sqlite_assets(id,owner,object_key,file_name,bytes,state,upload_lease_until,expires_at)
 values(asset_id,owner,owner::text||'/'||asset_id::text||'.sqlite',file_name,upload_bytes,'uploading',clock_timestamp()+interval '2 minutes',clock_timestamp()+interval '1 hour') returning * into asset;
 return jsonb_build_object('accepted',true,'asset',to_jsonb(asset));
end $$;

create function public.dbchat_complete_sqlite_upload(owner uuid,asset_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare asset public.dbchat_sqlite_assets;
begin
 perform public.dbchat_assert_account_active(owner);
 select * into asset from public.dbchat_sqlite_assets a where a.id=asset_id and a.owner=dbchat_complete_sqlite_upload.owner for update;
 if not found then raise exception 'Upload not found'; end if;
 if asset.state in ('pending','attached') then return to_jsonb(asset); end if;
 if asset.state<>'uploading' or asset.upload_lease_until<=clock_timestamp() then raise exception 'Upload has expired'; end if;
 update public.dbchat_sqlite_assets set state='pending',upload_lease_until=null,expires_at=clock_timestamp()+interval '1 hour',updated_at=clock_timestamp() where id=asset_id returning * into asset;
 return to_jsonb(asset);
end $$;

-- Existing references are retained, even if several old connections share a key.
-- Unknown size reserves the maximum legacy file size until metadata is available.
insert into public.dbchat_sqlite_assets(id,owner,object_key,file_name,bytes,state,expires_at)
select gen_random_uuid(),c.user_id,c.config->>'sqliteObjectKey',
 min(coalesce(c.config->>'sqliteFileName','database.sqlite')),
 coalesce(max(case when o.metadata->>'size' ~ '^[0-9]{1,12}$' then (o.metadata->>'size')::bigint end),52428800),'attached',null
from public.dbchat_connections c left join storage.objects o on o.bucket_id='dbchat-sqlite' and o.name=c.config->>'sqliteObjectKey'
where c.config->>'kind'='sqlite' and nullif(c.config->>'sqliteObjectKey','') is not null
group by c.user_id,c.config->>'sqliteObjectKey';

create function public.dbchat_connection_asset_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare owner_id uuid; old_key text; new_key text; asset public.dbchat_sqlite_assets;
begin
 owner_id:=case when TG_OP='DELETE' then OLD.user_id else NEW.user_id end;
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner_id::text,0));
 if TG_OP<>'DELETE' then
  perform public.dbchat_assert_account_active(owner_id);
  if TG_OP='UPDATE' and NEW.user_id<>OLD.user_id then raise exception 'Connection owner is immutable'; end if;
  if NEW.config->>'kind'='sqlite' then new_key:=nullif(NEW.config->>'sqliteObjectKey',''); end if;
 end if;
 if TG_OP<>'INSERT' and OLD.config->>'kind'='sqlite' then old_key:=nullif(OLD.config->>'sqliteObjectKey',''); end if;
 if new_key is not null then
  select * into asset from public.dbchat_sqlite_assets a where a.object_key=new_key and a.owner=owner_id for update;
  if not found then raise exception 'Register the SQLite upload before attaching it'; end if;
  if new_key is distinct from old_key then
   if asset.state<>'pending' or asset.expires_at<=clock_timestamp() then raise exception 'SQLite upload is unavailable or already attached'; end if;
   if exists(select 1 from public.dbchat_connections c where c.config->>'sqliteObjectKey'=new_key) then raise exception 'SQLite upload is already attached'; end if;
  elsif asset.state<>'attached' then raise exception 'SQLite asset is unavailable'; end if;
  update public.dbchat_sqlite_assets set state='attached',expires_at=null,upload_lease_until=null,updated_at=clock_timestamp() where id=asset.id;
 end if;
 if old_key is not null and old_key is distinct from new_key and not exists(select 1 from public.dbchat_connections c where c.config->>'sqliteObjectKey'=old_key and c.id<>OLD.id) then
  update public.dbchat_sqlite_assets set state='deleting',next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() where object_key=old_key and owner=owner_id and state<>'deleted';
 end if;
 if TG_OP='DELETE' then return OLD; end if;
 return NEW;
end $$;
create trigger dbchat_connection_assets before insert or update or delete on public.dbchat_connections for each row execute function public.dbchat_connection_asset_guard();

create function public.dbchat_account_write_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 -- Fenced worker finalization may update only chat counters while draining.
 if TG_TABLE_NAME='dbchat_chats' and TG_OP='UPDATE' then
  if current_setting('dbchat.terminal_finalize',true)='true'
   and (to_jsonb(NEW)-array['message_count','artifact_count','updated_at'])=(to_jsonb(OLD)-array['message_count','artifact_count','updated_at']) then return NEW; end if;
  -- The connection FK may clear its reference before Auth's chat cascade runs.
  if NEW.connection_id is null and OLD.connection_id is not null
   and (to_jsonb(NEW)-'connection_id')=(to_jsonb(OLD)-'connection_id')
   and not exists(select 1 from public.dbchat_connections where id=OLD.connection_id and user_id=OLD.user_id) then return NEW; end if;
 end if;
 perform public.dbchat_assert_account_active(NEW.user_id);
 return NEW;
end $$;
create trigger dbchat_profile_active before insert or update on public.dbchat_profiles for each row execute function public.dbchat_account_write_guard();
create trigger dbchat_session_active before insert or update on public.dbchat_sessions for each row execute function public.dbchat_account_write_guard();
create trigger dbchat_chat_active before insert or update on public.dbchat_chats for each row execute function public.dbchat_account_write_guard();
create trigger dbchat_turn_active before insert on public.dbchat_turns for each row execute function public.dbchat_account_write_guard();

-- Discover only old, well-formed objects with no saved reference. Never use age
-- to remove attached customer content. Repeat scans also catch late upload commits.
create function public.dbchat_discover_sqlite_orphans(grace_seconds integer default 3600,batch_size integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare item record; owner_id uuid; found_count integer:=0;
begin
 if grace_seconds<3600 or batch_size<1 or batch_size>500 then raise exception 'Invalid reconciliation bounds'; end if;
 for item in select o.name,o.metadata,o.created_at from storage.objects o
  where o.bucket_id='dbchat-sqlite' and o.created_at<clock_timestamp()-make_interval(secs=>grace_seconds)
   and o.name ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/[a-f0-9-]+[.]sqlite$'
   and not exists(select 1 from public.dbchat_sqlite_assets a where a.object_key=o.name)
  order by o.name limit batch_size
 loop
  owner_id:=split_part(item.name,'/',1)::uuid;
  if not pg_try_advisory_xact_lock(hashtextextended('dbchat-account:'||owner_id::text,0)) then continue; end if;
  if exists(select 1 from public.dbchat_connections c where c.config->>'sqliteObjectKey'=item.name) then continue; end if;
  insert into public.dbchat_sqlite_assets(id,owner,object_key,file_name,bytes,state,created_at)
   values(gen_random_uuid(),owner_id,item.name,'orphan.sqlite',case when item.metadata->>'size' ~ '^[0-9]{1,12}$' then (item.metadata->>'size')::bigint else 52428800 end,'deleting',item.created_at)
   on conflict(object_key) do nothing;
  if found then found_count:=found_count+1; end if;
 end loop;
 return found_count;
end $$;

create function public.dbchat_claim_asset_cleanup(batch_size integer default 20) returns setof public.dbchat_sqlite_assets
language plpgsql security definer set search_path='' as $$
declare candidate record; asset public.dbchat_sqlite_assets;
begin
 if batch_size<1 or batch_size>100 then raise exception 'Invalid cleanup batch'; end if;
 for candidate in select a.id,a.owner from public.dbchat_sqlite_assets a where
  (a.lease_until is null or a.lease_until<=clock_timestamp()) and a.next_attempt_at<=clock_timestamp() and (
   (state='uploading' and upload_lease_until<=clock_timestamp()) or (state='pending' and expires_at<=clock_timestamp()) or state='deleting'
   or (state='deleted' and exists(select 1 from storage.objects o where o.bucket_id='dbchat-sqlite' and o.name=a.object_key)))
  order by a.owner,a.id limit batch_size
 loop
  if not pg_try_advisory_xact_lock(hashtextextended('dbchat-account:'||candidate.owner::text,0)) then continue; end if;
  select * into asset from public.dbchat_sqlite_assets where id=candidate.id for update skip locked;
  if not found or (asset.lease_until is not null and asset.lease_until>clock_timestamp()) or asset.next_attempt_at>clock_timestamp() then continue; end if;
  -- The candidate query ran before the owner lock; an uploader may have
  -- completed in between. Recheck every eligibility condition under the lock.
  if not ((asset.state='uploading' and asset.upload_lease_until<=clock_timestamp())
   or (asset.state='pending' and asset.expires_at<=clock_timestamp()) or asset.state='deleting'
   or (asset.state='deleted' and exists(select 1 from storage.objects o where o.bucket_id='dbchat-sqlite' and o.name=asset.object_key))) then continue; end if;
  if exists(select 1 from public.dbchat_connections c where c.config->>'sqliteObjectKey'=asset.object_key) then
   update public.dbchat_sqlite_assets set state='attached',expires_at=null,lease_token=null,lease_until=null where id=asset.id;
   continue;
  end if;
  update public.dbchat_sqlite_assets set state='deleting',lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp() where id=asset.id returning * into asset;
  return next asset;
 end loop;
end $$;
create function public.dbchat_finish_asset_cleanup(asset_id uuid,token uuid,succeeded boolean) returns boolean
language plpgsql security invoker set search_path='' as $$
declare asset public.dbchat_sqlite_assets;
begin
 select * into asset from public.dbchat_sqlite_assets where id=asset_id for update;
 if not found or asset.lease_token is distinct from token or asset.lease_until is null or asset.lease_until<=clock_timestamp() or asset.state<>'deleting' then return false; end if;
 update public.dbchat_sqlite_assets set state=case when succeeded then 'deleted' else 'deleting' end,
  file_name=case when succeeded then 'deleted.sqlite' else file_name end,
  deleted_at=case when succeeded then clock_timestamp() else deleted_at end,lease_token=null,lease_until=null,
  next_attempt_at=clock_timestamp()+case when succeeded then interval '0 seconds' else interval '1 minute' end,updated_at=clock_timestamp()
 where id=asset_id and lease_token=token and lease_until>clock_timestamp() and state='deleting';
 return found;
end $$;

create function public.dbchat_begin_account_deletion(owner uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.dbchat_account_deletions;
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 if not exists(select 1 from public.dbchat_profiles where user_id=owner) and not exists(select 1 from public.dbchat_account_deletions d where d.owner=dbchat_begin_account_deletion.owner) then raise exception 'Account not found'; end if;
 insert into public.dbchat_account_deletions(owner) values(owner) on conflict do nothing;
 delete from public.dbchat_sessions where user_id=owner;
 select * into job from public.dbchat_account_deletions d where d.owner=dbchat_begin_account_deletion.owner;
 return to_jsonb(job);
end $$;
create function public.dbchat_claim_account_deletions(batch_size integer default 10) returns setof public.dbchat_account_deletions
language plpgsql security invoker set search_path='' as $$
declare job public.dbchat_account_deletions;
begin
 if batch_size<1 or batch_size>100 then raise exception 'Invalid deletion batch'; end if;
 for job in select * from public.dbchat_account_deletions where phase<>'complete' and next_attempt_at<=clock_timestamp() and (lease_until is null or lease_until<=clock_timestamp()) order by created_at for update skip locked limit batch_size loop
  update public.dbchat_account_deletions set lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp() where owner=job.owner returning * into job;
  return next job;
 end loop;
end $$;
create function public.dbchat_advance_account_deletion(owner uuid,token uuid,next_phase text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare job public.dbchat_account_deletions;
begin
 perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||owner::text,0));
 select * into job from public.dbchat_account_deletions d where d.owner=dbchat_advance_account_deletion.owner and lease_token=token and lease_until>clock_timestamp() for update;
 if not found or job.lease_until is null or job.lease_until<=clock_timestamp() then return false; end if;
 if next_phase='retry' then
  update public.dbchat_account_deletions set lease_token=null,lease_until=null,next_attempt_at=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() where dbchat_account_deletions.owner=job.owner;
  return true;
 end if;
 if next_phase not in ('storage','auth','complete') then raise exception 'Invalid deletion phase'; end if;
 if exists(select 1 from public.dbchat_sqlite_assets a where a.owner=job.owner and a.state='uploading' and a.upload_lease_until>clock_timestamp()) then return false; end if;
 if next_phase='storage' and job.phase not in ('waiting','storage') then return false; end if;
 if next_phase='auth' and job.phase not in ('storage','auth') then return false; end if;
 if next_phase='complete' then
  if job.phase<>'auth' then return false; end if;
  if exists(select 1 from public.dbchat_profiles where user_id=job.owner) then return false; end if;
  if exists(select 1 from storage.objects where bucket_id='dbchat-sqlite' and name like job.owner::text||'/%') then return false; end if;
  update public.dbchat_sqlite_assets set state='deleted',file_name='deleted.sqlite',deleted_at=clock_timestamp(),lease_token=null,lease_until=null,updated_at=clock_timestamp() where dbchat_sqlite_assets.owner=job.owner;
 end if;
 update public.dbchat_account_deletions set phase=next_phase,updated_at=clock_timestamp(),
  lease_until=clock_timestamp()+interval '2 minutes',completed_at=case when next_phase='complete' then clock_timestamp() else completed_at end,
  lease_token=case when next_phase='complete' then null else lease_token end
 where dbchat_account_deletions.owner=job.owner;
 return true;
end $$;

revoke all on function public.dbchat_assert_account_active(uuid),public.dbchat_asset_limit(uuid),public.dbchat_begin_sqlite_upload(uuid,uuid,text,bigint),public.dbchat_complete_sqlite_upload(uuid,uuid),public.dbchat_connection_asset_guard(),public.dbchat_account_write_guard(),public.dbchat_discover_sqlite_orphans(integer,integer),public.dbchat_claim_asset_cleanup(integer),public.dbchat_finish_asset_cleanup(uuid,uuid,boolean),public.dbchat_begin_account_deletion(uuid),public.dbchat_claim_account_deletions(integer),public.dbchat_advance_account_deletion(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.dbchat_assert_account_active(uuid),public.dbchat_asset_limit(uuid),public.dbchat_begin_sqlite_upload(uuid,uuid,text,bigint),public.dbchat_complete_sqlite_upload(uuid,uuid),public.dbchat_connection_asset_guard(),public.dbchat_account_write_guard(),public.dbchat_discover_sqlite_orphans(integer,integer),public.dbchat_claim_asset_cleanup(integer),public.dbchat_finish_asset_cleanup(uuid,uuid,boolean),public.dbchat_begin_account_deletion(uuid),public.dbchat_claim_account_deletions(integer),public.dbchat_advance_account_deletion(uuid,uuid,text) to service_role;
commit;
