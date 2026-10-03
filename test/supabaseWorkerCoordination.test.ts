// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
const a='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const q=async<T=Record<string,unknown>>(sql:string,args:unknown[]=[]) => (await db.query<T>(sql,args)).rows;
const claim=async(id:string,worker=a,user=owner,account=2,global=3) => (await q<{result:Record<string,unknown>}>('select public.dbchat_claim_turn_coordinated($1,$2,$2,$3,$4,$5,false,100,1000,$6,$7,$8,$9) result',[user,id,'request-'+id,{id:'user-'+id,role:'user',content:'Question'},'assistant-'+id,{},worker,account,global]))[0].result;
const snapshot=async(id:string) => (await q<{snapshot:Record<string,unknown>}>('select snapshot from public.dbchat_turns where id=$1',[id]))[0].snapshot;
const finalize=async(id:string,worker=a,user=owner) => (await q<{result:Record<string,unknown>}>('select public.dbchat_finalize_turn_fenced($1,$2,$3,$4,$5) result',[user,{...await snapshot(id),status:'complete',events:[{id:1,type:'complete',turnId:id,data:{message:'Answer'}}]}, {id:'assistant-'+id,role:'assistant',content:'Answer'},[],worker]))[0].result;
describe('durable worker coordination SQL',()=>{
 beforeAll(async()=>{
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key,bucket_id text references storage.buckets,name text,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz default now());alter table storage.objects enable row level security;`);
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()) await db.exec(await readFile(new URL(file,dir),'utf8'));
 },30000);
 beforeEach(async()=>{
  await db.exec('reset role;truncate auth.users cascade;truncate public.dbchat_workers cascade;truncate public.dbchat_account_deletions,public.dbchat_retention_reservations,public.dbchat_retained_usage;');
  await q('insert into auth.users values($1),($2)',[owner,other]);
  await q("insert into public.dbchat_profiles(user_id,email,display_name) values($1,'a@example.test','A'),($2,'b@example.test','B')",[owner,other]);
  await q("insert into public.dbchat_chats(id,user_id) values('one',$1),('two',$1),('three',$1),('other',$2)",[owner,other]);
  await q('select public.dbchat_register_worker($1,30000),public.dbchat_register_worker($2,30000)',[a,b]);
  await db.exec('set role service_role');
 });
 afterAll(()=>db.close());
 it('keeps live turns intact when another worker registers or runs recovery',async()=>{
  expect(await claim('one')).toMatchObject({created:true});
  expect(await q('select * from public.dbchat_recoverable_turns()')).toEqual([]);
  expect((await q<{ok:boolean}>('select public.dbchat_recover_turn($1,$2) ok',[owner,'one']))[0].ok).toBe(false);
  await expect(q('select public.dbchat_save_turn_fenced($1,$2,$3)',[owner,{...await snapshot('one'),status:'running'},b])).rejects.toThrow('DBCHAT_WORKER_FENCED');
  await expect(finalize('one',b)).rejects.toThrow('DBCHAT_WORKER_FENCED');
  expect((await snapshot('one')).status).toBe('queued');
  expect(await finalize('one')).toMatchObject({status:'complete'});
 });
 it('enforces capacity across workers while leaving idempotent retries uncharged',async()=>{
  expect(await claim('one',a,owner,1,2)).toMatchObject({created:true});
  expect(await claim('one',b,owner,1,2)).toMatchObject({created:false,turnId:'one'});
  expect(await claim('two',b,owner,1,2)).toEqual({capacityExceeded:true});
  expect(await claim('other',b,other,1,2)).toMatchObject({created:true});
  expect(await claim('two',b,owner,3,2)).toEqual({capacityExceeded:true});
  await finalize('one');
  expect(await claim('two',b,owner,1,2)).toMatchObject({created:true});
 });
 it('rejects expired workers, recovers only their turns, and never revives their lease',async()=>{
  await claim('one');await claim('other',b,other);
  await q('select public.dbchat_release_worker($1)',[a]);
  expect((await q<{result:{alive:boolean}}>('select public.dbchat_heartbeat_worker($1,30000) result',[a]))[0].result.alive).toBe(false);
  expect(await claim('two')).toEqual({leaseLost:true});
  await expect(finalize('one')).rejects.toThrow('DBCHAT_WORKER_FENCED');
  expect(await q('select * from public.dbchat_recoverable_turns()')).toEqual([{owner,turn_id:'one'}]);
  await q('select public.dbchat_recover_turn($1,$2)',[owner,'one']);
  expect(await snapshot('one')).toMatchObject({status:'error'});
  expect(await snapshot('other')).toMatchObject({status:'queued'});
  await expect(finalize('one')).rejects.toThrow('DBCHAT_WORKER_FENCED');
 });
 it('delivers cancellation to the owning worker and atomically rejects late completion',async()=>{
  await claim('one');
  expect((await q<{ok:boolean}>('select public.dbchat_cancel_turn($1,$2) ok',[other,'one']))[0].ok).toBe(false);
  await q('select public.dbchat_cancel_turn($1,$2)',[owner,'one']);
  expect((await q<{result:unknown}>('select public.dbchat_heartbeat_worker($1,30000) result',[a]))[0].result).toEqual({alive:true,cancelledTurns:['one']});
  expect(await finalize('one')).toMatchObject({status:'aborted',message:{content:'Answer stopped.'}});
  const messages=await q<{body:{content:string}}>("select body from public.dbchat_messages where body->>'role'='assistant'");
  expect(messages.map(row=>row.body.content)).toEqual(['Answer stopped.']);
 });
 it('drains account turns across workers and prevents new work after a deletion gate',async()=>{
  await claim('one');await claim('two',b);
  expect((await q<{n:number}>('select public.dbchat_cancel_owner_turns($1) n',[owner]))[0].n).toBe(2);
  await db.exec('reset role');await q('insert into public.dbchat_account_deletions(owner) values($1)',[owner]);await db.exec('set role service_role');
  await expect(claim('three')).rejects.toThrow('Account deletion');
  expect(await finalize('one')).toMatchObject({status:'aborted'});
  expect(await finalize('two',b)).toMatchObject({status:'aborted'});
  expect((await q<{n:number}>('select public.dbchat_cancel_owner_turns($1) n',[owner]))[0].n).toBe(0);
 });
 it('reconciles a failed terminal save after the runner acknowledges it has stopped',async()=>{
  await claim('one');await q('select public.dbchat_finish_turn_execution($1,$2,$3)',[owner,'one',a]);
  await expect(finalize('one')).rejects.toThrow('DBCHAT_WORKER_FENCED');
  await q('select public.dbchat_recover_turn($1,$2)',[owner,'one']);
  expect(await snapshot('one')).toMatchObject({status:'error'});
 });
 it('revokes unfenced and browser-only mutation entry points',async()=>{
  await expect(q('select public.dbchat_interrupt_pending_turns()')).rejects.toThrow('permission denied');
  await expect(q('select public.dbchat_finalize_turn($1,$2,null,$3)',[owner,{id:'one',status:'complete'},[]])).rejects.toThrow('permission denied');
  await db.exec('reset role;set role authenticated');
  await expect(q('select public.dbchat_register_worker($1,30000)',[a])).rejects.toThrow('permission denied');
  await expect(q('select public.dbchat_cancel_turn($1,$2)',[owner,'one'])).rejects.toThrow('permission denied');
 });
 it('prunes at most100 old unreferenced workers and retains ownership metadata for saved turns',async()=>{
  await claim('one');
  await db.exec("reset role;update public.dbchat_workers set lease_until=clock_timestamp()-interval '2 days';insert into public.dbchat_workers(id,lease_until) select gen_random_uuid(),clock_timestamp()-interval '2 days' from generate_series(1,123);set role service_role;");
  await q('select * from public.dbchat_recoverable_turns()');
  expect((await q<{n:number}>('select count(*)::int n from public.dbchat_workers'))[0].n).toBe(25);
  expect(await q('select id from public.dbchat_workers where id=$1',[a])).toHaveLength(1);
  await q('select * from public.dbchat_recoverable_turns()');
  expect((await q<{n:number}>('select count(*)::int n from public.dbchat_workers'))[0].n).toBe(1);
  expect(await snapshot('one')).toMatchObject({status:'queued'});
 });

});
