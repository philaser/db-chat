-- Run after the migration in a disposable database containing auth.users and Supabase roles.
begin;
insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222');
insert into public.dbchat_profiles(user_id,email,display_name) values ('11111111-1111-4111-8111-111111111111','a@example.test','A'),('22222222-2222-4222-8222-222222222222','b@example.test','B');
insert into public.dbchat_connections(id,user_id,config) values ('c1','11111111-1111-4111-8111-111111111111','{}');
insert into public.dbchat_chats(id,user_id,connection_id) values ('chat1','11111111-1111-4111-8111-111111111111','c1'),('chat2','22222222-2222-4222-8222-222222222222',null);
select public.dbchat_claim_turn('11111111-1111-4111-8111-111111111111','t1','chat1','r1','{"id":"m1","role":"user","content":"First question"}','m2');
select public.dbchat_claim_turn('11111111-1111-4111-8111-111111111111','different-id','chat1','r1','{"id":"m1","role":"user","content":"First question"}','m2');
select public.dbchat_finalize_turn('11111111-1111-4111-8111-111111111111','{"id":"t1","status":"complete","events":[]}','{"id":"m2","role":"assistant","content":"Answer"}','[{"queryId":"q1"}]');
select public.dbchat_finalize_turn('11111111-1111-4111-8111-111111111111','{"id":"t1","status":"complete","events":[]}','{"id":"m2","role":"assistant","content":"Answer"}','[{"queryId":"q1"}]');
-- A browser's stale autosave cannot delete server-committed messages or results.
select public.dbchat_update_chat('11111111-1111-4111-8111-111111111111','chat1','{"messages":[],"artifacts":[],"title":"Renamed"}');
do $$ begin
 if (select count(*) from public.dbchat_messages where chat_id='chat1')<>2 then raise exception 'Message count changed'; end if;
 if (select count(*) from public.dbchat_artifacts where chat_id='chat1')<>1 then raise exception 'Artifact count changed'; end if;
 if (select count(*) from public.dbchat_turns)<>1 then raise exception 'Request was not deduplicated'; end if;
 begin
  perform public.dbchat_update_chat('22222222-2222-4222-8222-222222222222','chat1','{"title":"Intruder"}');
  raise exception 'Cross-owner mutation succeeded';
 exception when raise_exception then if sqlerrm='Cross-owner mutation succeeded' then raise; end if; end;
 begin
  insert into public.dbchat_chats(id,user_id,connection_id) values ('bad','22222222-2222-4222-8222-222222222222','c1');
  raise exception 'Cross-owner connection succeeded';
 exception when foreign_key_violation then null; end;
 if has_table_privilege('authenticated','public.dbchat_connections','SELECT') then raise exception 'Browser may read credentials'; end if;
 if has_function_privilege('authenticated','public.dbchat_finalize_turn(uuid,jsonb,jsonb,jsonb)','EXECUTE') then raise exception 'Browser may forge owner'; end if;
end $$;
select public.dbchat_claim_turn('11111111-1111-4111-8111-111111111111','t2','chat1','r2','{"id":"m3","role":"user","content":"Second question"}','m4');
select public.dbchat_interrupt_pending_turns();
do $$ begin
 if not exists(select 1 from public.dbchat_turns where id='t2' and finalized and snapshot->>'status'='error') then raise exception 'Interrupted turn not recovered'; end if;
end $$;
-- Deleting Auth account cascades every tenant record, without touching the other user.
delete from auth.users where id='11111111-1111-4111-8111-111111111111';
do $$ begin
 if exists(select 1 from public.dbchat_chats where id='chat1') or exists(select 1 from public.dbchat_artifacts) then raise exception 'Cascade incomplete'; end if;
 if not exists(select 1 from public.dbchat_profiles where user_id='22222222-2222-4222-8222-222222222222') then raise exception 'Other tenant deleted'; end if;
end $$;
rollback;
