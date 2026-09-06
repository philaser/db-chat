-- Application schema v1. Execute through the Supabase migration role, never from the browser.
-- Auth owns passwords. Backend-only tables use RLS + no anon/authenticated grants.
begin;
create table public.dbchat_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null, display_name text not null, email_verified boolean not null default false,
  created_at timestamptz not null default now(), settings jsonb not null default '{}'::jsonb,
  encrypted_provider_key text
);
create table public.dbchat_sessions (
  id_hash text primary key, user_id uuid not null references public.dbchat_profiles(user_id) on delete cascade,
  encrypted_tokens text not null, access_expires_at bigint not null, expires_at bigint not null,
  absolute_expires_at bigint not null, refreshed_at bigint not null, refresh_lock_until bigint not null default 0, purpose text not null default 'login' check(purpose in ('login','recovery'))
);
create index dbchat_sessions_owner on public.dbchat_sessions(user_id);
create index dbchat_sessions_expiry on public.dbchat_sessions(expires_at);
create table public.dbchat_connections (
  id text primary key, user_id uuid not null references public.dbchat_profiles(user_id) on delete cascade,
  config jsonb not null, encrypted_secrets text, status text not null default 'unavailable',
  last_tested_at timestamptz, table_count integer, last_error text,
  unique(user_id,id)
);
create table public.dbchat_chats (
  id text primary key, user_id uuid not null references public.dbchat_profiles(user_id) on delete cascade,
  connection_id text, title text not null default 'New chat', custom_title boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  message_count integer not null default 0, artifact_count integer not null default 0,
  unique(user_id,id),
  foreign key(user_id,connection_id) references public.dbchat_connections(user_id,id) on delete set null (connection_id)
);
create index dbchat_chats_recent on public.dbchat_chats(user_id,updated_at desc);
create table public.dbchat_messages (
  user_id uuid not null, chat_id text not null, position integer not null, body jsonb not null,
  primary key(user_id,chat_id,position),
  foreign key(user_id,chat_id) references public.dbchat_chats(user_id,id) on delete cascade
);
create table public.dbchat_artifacts (
  user_id uuid not null, chat_id text not null, position integer not null, body jsonb not null,
  primary key(user_id,chat_id,position),
  foreign key(user_id,chat_id) references public.dbchat_chats(user_id,id) on delete cascade
);
create table public.dbchat_turns (
  id text primary key, user_id uuid not null references public.dbchat_profiles(user_id) on delete cascade,
  chat_id text, request_id text, assistant_message_id text,
  snapshot jsonb not null, finalized boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,request_id),
  foreign key(user_id,chat_id) references public.dbchat_chats(user_id,id) on delete cascade
);
create index dbchat_turns_owner on public.dbchat_turns(user_id,id);
create index dbchat_turns_chat on public.dbchat_turns(user_id,chat_id);

-- No public client has table access, even to ciphertext. Service role bypasses RLS;
-- the Node repository MUST keep explicit owner predicates for all tenant operations.
alter table public.dbchat_profiles enable row level security;
alter table public.dbchat_sessions enable row level security;
alter table public.dbchat_connections enable row level security;
alter table public.dbchat_chats enable row level security;
alter table public.dbchat_messages enable row level security;
alter table public.dbchat_artifacts enable row level security;
alter table public.dbchat_turns enable row level security;
revoke all on public.dbchat_profiles,public.dbchat_sessions,public.dbchat_connections,public.dbchat_chats,public.dbchat_messages,public.dbchat_artifacts,public.dbchat_turns from anon,authenticated;
grant select,insert,update,delete on public.dbchat_profiles,public.dbchat_sessions,public.dbchat_connections,public.dbchat_chats,public.dbchat_messages,public.dbchat_artifacts,public.dbchat_turns to service_role;

create function public.dbchat_update_chat(owner uuid,chat text,changes jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare current_chat public.dbchat_chats; new_title text;
begin
 select * into current_chat from public.dbchat_chats where user_id=owner and id=chat for update;
 if not found then raise exception 'Chat not found'; end if;
 if changes ? 'title' then
  new_title := regexp_replace(trim(changes->>'title'),'\s+',' ','g');
  if length(new_title)=0 or length(new_title)>72 then raise exception 'Invalid chat title'; end if;
  update public.dbchat_chats set title=new_title,custom_title=true where user_id=owner and id=chat;
 end if;
 if changes ? 'connectionId' then
  update public.dbchat_chats set connection_id=changes->>'connectionId' where user_id=owner and id=chat;
 end if;
 -- Once server turns exist, browser autosave cannot overwrite committed messages/results.
 if not exists(select 1 from public.dbchat_turns where user_id=owner and chat_id=chat) then
  if changes ? 'messages' then
   delete from public.dbchat_messages where user_id=owner and chat_id=chat;
   insert into public.dbchat_messages(user_id,chat_id,position,body)
    select owner,chat,(ordinality-1)::integer,value from jsonb_array_elements(changes->'messages') with ordinality;
   if not current_chat.custom_title and not changes ? 'title' then
    select left(regexp_replace(value->>'content','\s+',' ','g'),72) into new_title
     from jsonb_array_elements(changes->'messages') where value->>'role'='user' limit 1;
    update public.dbchat_chats set title=coalesce(nullif(new_title,''),'New chat') where user_id=owner and id=chat;
   end if;
  end if;
  if changes ? 'artifacts' then
   delete from public.dbchat_artifacts where user_id=owner and chat_id=chat;
   insert into public.dbchat_artifacts(user_id,chat_id,position,body)
    select owner,chat,(ordinality-1)::integer,value from jsonb_array_elements(changes->'artifacts') with ordinality;
  end if;
 end if;
 update public.dbchat_chats set updated_at=now(),message_count=(select count(*) from public.dbchat_messages where user_id=owner and chat_id=chat),artifact_count=(select count(*) from public.dbchat_artifacts where user_id=owner and chat_id=chat) where user_id=owner and id=chat;
end $$;

create function public.dbchat_claim_turn(owner uuid,turn_id text,chat text,request_id text,user_message jsonb,assistant_message_id text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior public.dbchat_turns; current_chat public.dbchat_chats; pos integer;
begin
 -- Per-owner advisory lock serializes identical request IDs even across different chats.
 perform pg_advisory_xact_lock(hashtextextended(owner::text || ':' || request_id,0));
 select * into prior from public.dbchat_turns t where t.user_id=owner and t.request_id=dbchat_claim_turn.request_id;
 if found then
  if prior.chat_id<>chat then raise exception 'Request belongs to another chat'; end if;
  return jsonb_build_object('turnId',prior.id,'created',false);
 end if;
 select * into current_chat from public.dbchat_chats where user_id=owner and id=chat for update;
 if not found then raise exception 'Chat not found'; end if;
 if exists(select 1 from public.dbchat_turns where user_id=owner and chat_id=chat and not finalized) then raise exception 'A turn is already active in this chat'; end if;
 insert into public.dbchat_turns(id,user_id,chat_id,request_id,assistant_message_id,snapshot)
  values(turn_id,owner,chat,request_id,assistant_message_id,jsonb_build_object('id',turn_id,'connectionId',current_chat.connection_id,'status','queued','events','[]'::jsonb));
 select coalesce(max(position)+1,0) into pos from public.dbchat_messages where user_id=owner and chat_id=chat;
 insert into public.dbchat_messages values(owner,chat,pos,user_message);
 update public.dbchat_chats set updated_at=now(),message_count=message_count+1,
  title=case when not custom_title and message_count=0 then left(regexp_replace(user_message->>'content','\s+',' ','g'),72) else title end where user_id=owner and id=chat;
 return jsonb_build_object('turnId',turn_id,'created',true);
end $$;

create function public.dbchat_save_turn(owner uuid,turn jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 insert into public.dbchat_turns(id,user_id,snapshot) values(turn->>'id',owner,turn)
 on conflict(id) do update set snapshot=excluded.snapshot,updated_at=now()
 where public.dbchat_turns.user_id=owner and not public.dbchat_turns.finalized;
 if not found then raise exception 'Turn not found or finalized'; end if;
end $$;

create function public.dbchat_finalize_turn(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare stored public.dbchat_turns; pos integer; a jsonb;
begin
 select * into stored from public.dbchat_turns where user_id=owner and id=turn->>'id' for update;
 if not found then raise exception 'Turn not found'; end if;
 if stored.finalized then return; end if;
 if turn->>'status' not in ('complete','error','aborted') then raise exception 'Turn is not terminal'; end if;
 if stored.chat_id is not null then
  perform 1 from public.dbchat_chats where user_id=owner and id=stored.chat_id for update;
  if assistant_message is not null then
   select coalesce(max(position)+1,0) into pos from public.dbchat_messages where user_id=owner and chat_id=stored.chat_id;
   insert into public.dbchat_messages values(owner,stored.chat_id,pos,assistant_message || jsonb_build_object('id',stored.assistant_message_id));
  end if;
  select coalesce(max(position)+1,0) into pos from public.dbchat_artifacts where user_id=owner and chat_id=stored.chat_id;
  for a in select value from jsonb_array_elements(result_artifacts) loop
   insert into public.dbchat_artifacts values(owner,stored.chat_id,pos,a); pos:=pos+1;
  end loop;
  update public.dbchat_chats set updated_at=now(),message_count=(select count(*) from public.dbchat_messages where user_id=owner and chat_id=stored.chat_id),artifact_count=(select count(*) from public.dbchat_artifacts where user_id=owner and chat_id=stored.chat_id) where user_id=owner and id=stored.chat_id;
 end if;
 update public.dbchat_turns set snapshot=turn,finalized=true,updated_at=now() where user_id=owner and id=stored.id;
end $$;
revoke all on function public.dbchat_update_chat(uuid,text,jsonb),public.dbchat_claim_turn(uuid,text,text,text,jsonb,text),public.dbchat_save_turn(uuid,jsonb),public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.dbchat_update_chat(uuid,text,jsonb),public.dbchat_claim_turn(uuid,text,text,text,jsonb,text),public.dbchat_save_turn(uuid,jsonb),public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb) to service_role;
-- The initial deployment is one Node service. Run once at startup before accepting turns.
-- Multiple concurrently starting replicas require worker leases instead of this operation.
create function public.dbchat_interrupt_pending_turns() returns void
language plpgsql security invoker set search_path='' as $$
declare pending public.dbchat_turns;
begin
 for pending in select * from public.dbchat_turns where not finalized for update loop
  perform public.dbchat_finalize_turn(pending.user_id,
   pending.snapshot || jsonb_build_object('status','error','error','The server restarted before this answer finished. Please retry.'),
   null,'[]'::jsonb);
 end loop;
end $$;
revoke all on function public.dbchat_interrupt_pending_turns() from public,anon,authenticated;
grant execute on function public.dbchat_interrupt_pending_turns() to service_role;
commit;
