-- Server-owned evidence, source provenance, editable connection knowledge, recovery.
-- Apply only with explicit deployment authorization. No remote application is implied.
begin;
alter table public.dbchat_chats add column source jsonb, add column pinned boolean not null default false;
update public.dbchat_chats c set source=jsonb_build_object('connectionId',d.id,'label',d.config->>'label','kind',d.config->>'kind','capturedAt',now())
from public.dbchat_connections d where c.user_id=d.user_id and c.connection_id=d.id;

create table public.dbchat_connection_knowledge (
 user_id uuid not null, connection_id text not null, body jsonb not null,
 primary key(user_id,connection_id),
 foreign key(user_id,connection_id) references public.dbchat_connections(user_id,id) on delete cascade,
 check(jsonb_typeof(body->'glossary')='array' and jsonb_typeof(body->'examples')='array'),
 check(jsonb_array_length(body->'glossary')<=100 and jsonb_array_length(body->'examples')<=50)
);
alter table public.dbchat_connection_knowledge enable row level security;
revoke all on public.dbchat_connection_knowledge from public,anon,authenticated;
grant select,insert,update,delete on public.dbchat_connection_knowledge to service_role;

create or replace function public.dbchat_update_chat(owner uuid,chat text,changes jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare new_title text;
begin
 if exists(select 1 from jsonb_object_keys(changes) key where key not in ('title','pinned')) then raise exception 'Only title and pinned can be changed'; end if;
 perform 1 from public.dbchat_chats where user_id=owner and id=chat for update;
 if not found then raise exception 'Chat not found'; end if;
 if changes ? 'title' then
  new_title:=regexp_replace(trim(changes->>'title'),'\s+',' ','g');
  if length(new_title)=0 or length(new_title)>72 then raise exception 'Invalid chat title'; end if;
  update public.dbchat_chats set title=new_title,custom_title=true where user_id=owner and id=chat;
 end if;
 if changes ? 'pinned' then
  if jsonb_typeof(changes->'pinned')<>'boolean' then raise exception 'Invalid pinned value'; end if;
  update public.dbchat_chats set pinned=(changes->>'pinned')::boolean where user_id=owner and id=chat;
 end if;
 update public.dbchat_chats set updated_at=now() where user_id=owner and id=chat;
end $$;

create function public.dbchat_update_message_metadata(owner uuid,chat text,message_id text,changes jsonb) returns void
language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from jsonb_object_keys(changes) key where key not in ('pinned','feedback')) then raise exception 'Only answer metadata can be changed'; end if;
 if changes ? 'pinned' and jsonb_typeof(changes->'pinned')<>'boolean' then raise exception 'Invalid pinned value'; end if;
 if changes ? 'feedback' and (jsonb_typeof(changes->'feedback') is distinct from 'object' or coalesce(changes->'feedback'->>'rating','') not in ('helpful','unhelpful')) then raise exception 'Invalid feedback rating'; end if;
 update public.dbchat_messages set body=body || changes where user_id=owner and chat_id=chat and body->>'id'=message_id and body->>'role'='assistant';
 if not found then raise exception 'Answer not found'; end if;
end $$;
revoke all on function public.dbchat_update_message_metadata(uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.dbchat_update_message_metadata(uuid,text,text,jsonb) to service_role;

create or replace function public.dbchat_claim_turn(owner uuid,turn_id text,chat text,request_id text,user_message jsonb,assistant_message_id text) returns jsonb
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
 if user_message->>'id'=assistant_message_id or exists(select 1 from public.dbchat_messages where user_id=owner and chat_id=chat and body->>'id' in (user_message->>'id',assistant_message_id)) then raise exception 'Message identifiers must be unique within this chat'; end if;
 insert into public.dbchat_turns(id,user_id,chat_id,request_id,assistant_message_id,snapshot)
  values(turn_id,owner,chat,request_id,assistant_message_id,jsonb_build_object('id',turn_id,'connectionId',current_chat.connection_id,'chatId',chat,'assistantMessageId',assistant_message_id,'question',user_message->>'content','createdAt',now(),'status','queued','events','[]'::jsonb));
 select coalesce(max(position)+1,0) into pos from public.dbchat_messages where user_id=owner and chat_id=chat;
 insert into public.dbchat_messages values(owner,chat,pos,user_message);
 update public.dbchat_chats set updated_at=now(),message_count=message_count+1,
  title=case when not custom_title and message_count=0 then left(regexp_replace(user_message->>'content','\s+',' ','g'),72) else title end where user_id=owner and id=chat;
 return jsonb_build_object('turnId',turn_id,'created',true);
end $$;

create or replace function public.dbchat_finalize_turn(owner uuid,turn jsonb,assistant_message jsonb,result_artifacts jsonb) returns void
language plpgsql security invoker set search_path='' as $$
declare stored public.dbchat_turns; pos integer; a jsonb;
begin
 select * into stored from public.dbchat_turns where user_id=owner and id=turn->>'id' for update;
 if not found then raise exception 'Turn not found'; end if;
 if stored.finalized then return; end if;
 if turn->>'status' not in ('complete','error','aborted') then raise exception 'Turn is not terminal'; end if;
 if assistant_message is null and turn->>'status' in ('error','aborted') and stored.assistant_message_id is not null then
  assistant_message := jsonb_build_object('id',stored.assistant_message_id,'role','assistant','content',coalesce(turn->>'error','Answer stopped.'),'createdAt',now(),'turn',jsonb_build_object('id',stored.id,'status',turn->>'status','question',coalesce(turn->>'question',stored.snapshot->>'question',''),'attemptOf',turn->>'attemptOf','intent',coalesce(turn->'intent',stored.snapshot->'intent')));
  turn := turn || jsonb_build_object('message',assistant_message);
 end if;
 if stored.chat_id is not null then
  perform 1 from public.dbchat_chats where user_id=owner and id=stored.chat_id for update;
  if assistant_message is not null then
   select coalesce(max(position)+1,0) into pos from public.dbchat_messages where user_id=owner and chat_id=stored.chat_id;
   insert into public.dbchat_messages values(owner,stored.chat_id,pos,assistant_message || jsonb_build_object('id',stored.assistant_message_id));
  end if;
  select coalesce(max(position)+1,0) into pos from public.dbchat_artifacts where user_id=owner and chat_id=stored.chat_id;
  for a in select value from jsonb_array_elements(result_artifacts) loop
   insert into public.dbchat_artifacts values(owner,stored.chat_id,pos,a || jsonb_build_object('messageId',stored.assistant_message_id)); pos:=pos+1;
  end loop;
  update public.dbchat_chats set updated_at=now(),message_count=(select count(*) from public.dbchat_messages where user_id=owner and chat_id=stored.chat_id),artifact_count=(select count(*) from public.dbchat_artifacts where user_id=owner and chat_id=stored.chat_id) where user_id=owner and id=stored.chat_id;
 end if;
 update public.dbchat_turns set snapshot=turn,finalized=true,updated_at=now() where user_id=owner and id=stored.id;
end $$;
create function public.dbchat_search_chats(owner uuid,query_text text,source_id text,pinned_only boolean,page_offset integer,page_limit integer) returns jsonb
language sql stable security invoker set search_path='' as $$
 with matches as (
  select c.* from public.dbchat_chats c where c.user_id=owner
   and (source_id is null or c.connection_id=source_id or c.source->>'connectionId'=source_id)
   and (not pinned_only or c.pinned)
   and (query_text='' or strpos(lower(c.title),lower(query_text))>0 or exists(
    select 1 from public.dbchat_messages m where m.user_id=owner and m.chat_id=c.id and strpos(lower(m.body->>'content'),lower(query_text))>0))
 ), page as (select * from matches order by updated_at desc,id limit least(greatest(page_limit,1),100) offset greatest(page_offset,0))
 select jsonb_build_object('chats',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),'total',(select count(*) from matches));
$$;
revoke all on function public.dbchat_search_chats(uuid,text,text,boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.dbchat_search_chats(uuid,text,text,boolean,integer,integer) to service_role;
create or replace function public.dbchat_interrupt_pending_turns() returns void
language plpgsql security invoker set search_path='' as $$
declare pending public.dbchat_turns;
begin
 for pending in select * from public.dbchat_turns where not finalized for update loop
  perform public.dbchat_finalize_turn(pending.user_id,
   pending.snapshot || jsonb_build_object('status','error','error','The server restarted before this answer finished. Please retry.'),
   null,coalesce(pending.snapshot->'artifacts','[]'::jsonb));
 end loop;
end $$;
commit;
