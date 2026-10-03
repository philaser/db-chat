// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { SupabaseExportJobs } from '../src/server/exports/supabaseExportJobs.js';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const limits = { maxRows: 100, maxBytes: 1024, timeoutMs: 5000, ttlMs: 3600000 };
let db: PGlite;
const instances: SupabaseExportJobs[] = [];
let objects: Map<string, Uint8Array>;
let losePublicationResponse = false;
let loseUploadResponse = false;
// Separate helper avoids changing SQL behavior to simulate HTTP failures.
async function call(name: string, args: Record<string, unknown>): Promise<any> {
  const entries = Object.entries(args);
  const result = await db.query<{ result: unknown }>(`select public.dbchat_export_${name}(${entries.map(([key], i) => `${key} => $${i + 1}`).join(',')}) as result`, entries.map(([, value]) => value));
  return result.rows[0].result;
}
const fetcher: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.pathname.startsWith('/rest/v1/rpc/')) {
    const name = url.pathname.split('dbchat_export_')[1];
    const args = JSON.parse(String(init.body));
    try {
      const result = await call(name, args);
      if (name === 'finish' && args.p_status === 'ready' && losePublicationResponse) { losePublicationResponse = false; throw new TypeError('Synthetic lost response'); }
      return new Response(JSON.stringify(result ?? null));
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return new Response(JSON.stringify({ message: String(error) }), { status: 400 });
    }
  }
  if (url.pathname === '/rest/v1/dbchat_exports') {
    const where: string[] = []; const args: unknown[] = [];
    for (const key of ['user_id','id','chat_id','remove_requested']) {
      const value = url.searchParams.get(key);
      if (value?.startsWith('eq.')) { args.push(value.slice(3)); where.push(`${key}=$${args.length}`); }
    }
    if (url.searchParams.has('expires_at')) where.push('expires_at>clock_timestamp()');
    if (url.searchParams.has('or')) where.push('(executing or not object_deleted)');
    const limit = Number(url.searchParams.get('limit') ?? '10');
    const rows = (await db.query('select * from dbchat_exports' + (where.length ? ' where ' + where.join(' and ') : '') + ' order by created_at desc limit ' + limit, args)).rows;
    return new Response(JSON.stringify(rows));
  }
  const prefix = '/storage/v1/object/';
  if (url.pathname.startsWith(prefix)) {
    if (init.method === 'DELETE') {
      for (const key of JSON.parse(String(init.body)).prefixes) objects.delete(key);
      return new Response('{}');
    }
    const key = url.pathname.replace(prefix, '').replace(/^authenticated\//, '').replace(/^dbchat-exports\//, '');
    if (init.method === 'POST') {
      objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer()));
      if (loseUploadResponse) { loseUploadResponse = false; throw new TypeError('Synthetic lost upload response'); }
      return new Response('{}');
    }
    return objects.has(key) ? new Response(new Uint8Array(objects.get(key)!)) : new Response('{}', { status: 404 });
  }
  throw new Error('Unexpected route ' + url.pathname);
};
async function instance() {
  const jobs = new SupabaseExportJobs(limits, { url: 'https://fixture.example', serviceRoleKey: 'synthetic', fetch: fetcher, pollMs: 20 });
  instances.push(jobs); await jobs.initialize(); return jobs;
}
async function create(user = owner, worker = randomUUID()) {
  const id = randomUUID();
  const row = await call('create', { p_owner: user, p_id: id, p_worker: worker, p_chat: user === owner ? 'chat' : 'other-chat', p_details: { title: 'Evidence', format: 'csv', scope: 'all' }, p_limits: limits });
  return { id, worker, row };
}
beforeEach(async () => {
  db = new PGlite(); objects = new Map(); losePublicationResponse = false; loseUploadResponse = false;
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create table dbchat_chats(id text primary key,user_id uuid);
    insert into dbchat_chats values ('chat','${owner}'),('other-chat','${other}');
    create table dbchat_account_deletions(owner uuid primary key);
    create function dbchat_assert_account_active(p_owner uuid) returns void language plpgsql as $$ begin
      perform pg_advisory_xact_lock(hashtextextended('dbchat-account:'||p_owner::text,0));
      if exists(select 1 from dbchat_account_deletions where owner=p_owner) then raise exception 'Account deletion pending'; end if;
    end $$;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text); alter table storage.objects enable row level security;`);
  await db.exec(await readFile(new URL('../supabase/migrations/202610030006_durable_exports.sql', import.meta.url), 'utf8'));
}, 15000);
afterEach(async () => { await Promise.all(instances.splice(0).map(jobs => jobs.close())); await db.close(); });

describe('durable export ownership and storage', () => {
  it('serves a ready file from another worker and preserves it through worker shutdown', async () => {
    const first = await instance(); const second = await instance();
    const job = await first.start(owner, 'chat', { title: 'Evidence', format: 'csv', scope: 'all' }, async context => { await writeFile(context.filename, 'total\n30\n'); context.progress(1, 9); });
    await expect.poll(async () => (await second.get(owner, job.id))?.status).toBe('ready');
    await first.close();
    const stream = await second.read(owner, job.id); const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('total\n30\n');
    expect(await second.get(other, job.id)).toBeUndefined();
    expect(await second.read(other, job.id)).toBeUndefined();
  });
  it('does not downgrade or delete a ready file after a lost publication response', async () => {
    losePublicationResponse = true;
    const jobs = await instance();
    const job = await jobs.start(owner, 'chat', { title: 'Evidence', format: 'json', scope: 'visible' }, async context => { await writeFile(context.filename, '[]'); });
    await expect.poll(async () => (await jobs.get(owner, job.id))?.status).toBe('ready');
    await jobs.close();
    expect(objects.size).toBe(1);
    expect((await jobs.get(owner, job.id))?.status).toBe('ready');
  });
  it('retains a cleanup key after a lost upload response and removes the uncommitted object', async () => {
    loseUploadResponse = true;
    const jobs = await instance();
    const job = await jobs.start(owner, 'chat', { title: 'Evidence', format: 'json', scope: 'visible' }, async context => { await writeFile(context.filename, '[]'); });
    await expect.poll(async () => (await jobs.get(owner, job.id))?.status).toBe('error');
    await expect.poll(() => objects.size).toBe(0);
    expect(await jobs.read(owner, job.id)).toBeUndefined();
  });
  it('holds cancelled execution capacity until its worker acknowledges cleanup', async () => {
    const first = await create(); const next = await create();
    expect((await call('tick', { p_id: first.id, p_worker: first.worker, p_start: true })).status).toBe('running');
    await call('cancel', { p_owner: owner, p_id: first.id });
    expect((await call('tick', { p_id: next.id, p_worker: next.worker, p_start: true })).status).toBe('queued');
    await call('finish', { p_id: first.id, p_worker: first.worker, p_status: 'cancelled', p_rows: 0, p_bytes: 0 });
    expect((await call('tick', { p_id: next.id, p_worker: next.worker, p_start: true })).status).toBe('running');
  });
  it('fences expired workers and recovers a crashed job without publishing its object', async () => {
    const job = await create();
    await call('tick', { p_id: job.id, p_worker: job.worker, p_start: true });
    await db.query("update dbchat_exports set lease_until=clock_timestamp()-interval '1 second' where id=$1", [job.id]);
    expect(await call('tick', { p_id: job.id, p_worker: job.worker })).toBeNull();
    await expect(call('finish', { p_id: job.id, p_worker: job.worker, p_status: 'ready', p_rows: 1, p_bytes: 2 })).rejects.toThrow('lease lost');
    const token = randomUUID();
    expect((await call('cleanup_claim', { p_token: token })).id).toBe(job.id);
    expect((await db.query<{status:string}>('select status from dbchat_exports where id=$1', [job.id])).rows[0].status).toBe('error');
  });
  it('does not clean ready/active files and fences cleanup acknowledgements', async () => {
    const job = await create(); await call('tick', { p_id: job.id, p_worker: job.worker, p_start: true });
    expect(await call('cleanup_claim', { p_token: randomUUID() })).toBeNull();
    await call('finish', { p_id: job.id, p_worker: job.worker, p_status: 'ready', p_rows: 1, p_bytes: 2 });
    expect(await call('cleanup_claim', { p_token: randomUUID() })).toBeNull();
    await call('cancel', { p_owner: owner, p_id: job.id, p_remove: true });
    const token = randomUUID(); await call('cleanup_claim', { p_token: token });
    await call('cleanup_finish', { p_id: job.id, p_token: randomUUID() });
    expect((await db.query<{object_deleted:boolean}>('select object_deleted from dbchat_exports')).rows[0].object_deleted).toBe(false);
    await call('cleanup_finish', { p_id: job.id, p_token: token });
    const row = (await db.query<{object_deleted:boolean;tombstone_until:Date}>('select object_deleted,tombstone_until from dbchat_exports')).rows[0];
    expect(row.object_deleted).toBe(true); expect(row.tombstone_until).toBeTruthy();
    expect(await call('cleanup_claim', { p_token: randomUUID() })).toBeNull();
  });
  it('reserves retained capacity until physical cleanup and rejects wrong-owner creation', async () => {
    const jobs = [];
    for (let i=0;i<5;i++) jobs.push(await create());
    await expect(create()).rejects.toThrow('DBCHAT_EXPORT_ACCOUNT_LIMIT');
    await call('cancel', { p_owner: owner, p_id: jobs[0].id, p_remove: true });
    await expect(create()).rejects.toThrow('DBCHAT_EXPORT_ACCOUNT_LIMIT');
    const token = randomUUID(); const row = await call('cleanup_claim', { p_token: token });
    await call('cleanup_finish', { p_id: row.id, p_token: token });
    await expect(create()).resolves.toBeTruthy();
    await expect(call('create', { p_owner: other, p_id: randomUUID(), p_worker: randomUUID(), p_chat: 'chat', p_details: {title:'bad',format:'csv',scope:'all'},p_limits:limits })).rejects.toThrow('Chat not found');
  });
  it('blocks publication/admission during deletion and denies browser table/RPC access', async () => {
    const job = await create(); await call('tick', { p_id: job.id, p_worker: job.worker, p_start: true });
    await db.query('insert into dbchat_account_deletions values($1)', [owner]);
    await expect(create()).rejects.toThrow('Account deletion pending');
    await expect(call('finish', { p_id: job.id, p_worker: job.worker, p_status: 'ready', p_rows: 1, p_bytes: 2 })).rejects.toThrow('Account deletion pending');
    await db.exec('set role authenticated');
    await expect(db.query('select * from dbchat_exports')).rejects.toThrow('permission denied');
    await expect(call('cleanup_claim', { p_token: randomUUID() })).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });
});
