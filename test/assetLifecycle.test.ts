// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteSupabaseAuthUser, SupabaseAssetLifecycle } from '../src/server/assetLifecycle';
import type { SqliteObjectStorage } from '../src/server/supabaseSqliteStorage';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const db = new PGlite();
const scalar = async <T = any>(sql: string, args: unknown[] = []): Promise<T> => (await db.query<{ result: T }>(sql, args)).rows[0].result;
const begin = (id = randomUUID(), who = owner, bytes = 32) => scalar('select dbchat_begin_sqlite_upload($1,$2,$3,$4) as result', [who, id, 'fixture.sqlite', bytes]);
const ready = async (who = owner) => { const { asset } = await begin(randomUUID(), who); await scalar('select dbchat_complete_sqlite_upload($1,$2) as result', [who, asset.id]); return asset; };
const attach = (id: string, key: string, who = owner) => db.query('insert into dbchat_connections(id,user_id,config) values ($1,$2,$3)', [id, who, { kind: 'sqlite', sqliteObjectKey: key }]);
const cleanups = () => db.query<{ id: string; owner: string; object_key: string; lease_token: string }>('select * from dbchat_claim_asset_cleanup()');
const object = (key: string, age = '2 hours') => db.query("insert into storage.objects(id,bucket_id,name,metadata,created_at) values ($1,'dbchat-sqlite',$2,'{\"size\":32}',now()-$3::interval)", [randomUUID(), key, age]);
let legacy: any[];

describe('durable uploaded assets and deletion SQL', () => {
  beforeAll(async () => {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create schema storage; create table storage.objects(id uuid primary key,bucket_id text,name text,metadata jsonb,created_at timestamptz default now());
      grant usage on schema storage to service_role; grant select on storage.objects to service_role;`);
    for (const file of ['202609050001_dbchat_accounts.sql', '202609080001_conversation_recovery.sql', '202610030001_managed_turn_limits.sql', '202610030002_upload_limits.sql']) await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    await db.query('insert into auth.users values ($1)', [owner]);
    await db.query("insert into dbchat_profiles(user_id,email,display_name) values ($1,'legacy@example.test','Legacy')", [owner]);
    const key = owner + '/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.sqlite';
    await object(key);
    await attach('legacy-one', key); await attach('legacy-two', key);
    await db.exec(await readFile(new URL('../supabase/migrations/202610030004_asset_lifecycle.sql', import.meta.url), 'utf8'));
    legacy = (await db.query('select owner,object_key,bytes,state from dbchat_sqlite_assets')).rows;
  }, 30000);
  beforeEach(async () => {
    await db.exec('reset role; truncate auth.users cascade; truncate dbchat_sqlite_assets,dbchat_account_deletions,storage.objects;');
    await db.query('insert into auth.users values ($1),($2)', [owner, other]);
    await db.query("insert into dbchat_profiles(user_id,email,display_name) values ($1,'a@example.test','A'),($2,'b@example.test','B')", [owner, other]);
  });
  afterAll(() => db.close());

  it('backfills existing shared references without scheduling customer content for deletion', () => {
    expect(legacy).toEqual([{ owner, object_key: owner + '/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.sqlite', bytes: 32, state: 'attached' }]);
  });
  it('registers a deterministic object key before upload and reserves retained bytes idempotently', async () => {
    const id = randomUUID();
    const first = await begin(id);
    expect(first).toMatchObject({ accepted: true, asset: { id, owner, object_key: owner + '/' + id + '.sqlite', state: 'uploading', bytes: 32 } });
    expect(await begin(id)).toEqual(first);
    await expect(begin(id, other)).rejects.toThrow('identity conflict');
    expect((await db.query('select * from dbchat_sqlite_assets')).rows).toHaveLength(1);
    expect((await cleanups()).rows).toEqual([]);
  });
  it('recovers a lost upload response after restart and catches an even later Storage commit', async () => {
    const { asset } = await begin();
    await object(asset.object_key, '0 seconds'); // Storage accepted, uploader lost its response.
    await db.exec("update dbchat_sqlite_assets set upload_lease_until=now()-interval '1 second'");
    const first = (await cleanups()).rows[0];
    await expect(scalar('select dbchat_complete_sqlite_upload($1,$2) as result', [owner, asset.id])).rejects.toThrow('expired');
    await db.query('delete from storage.objects where name=$1', [asset.object_key]);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [first.id, first.lease_token])).toBe(true);
    expect((await db.query('select owner,object_key,file_name,bytes,state from dbchat_sqlite_assets where id=$1', [asset.id])).rows[0])
      .toEqual({ owner, object_key: asset.object_key, file_name: 'deleted.sqlite', bytes: 32, state: 'deleted' });
    await object(asset.object_key, '0 seconds'); // Extremely late remote completion after cleanup.
    const retry = (await cleanups()).rows[0];
    expect(retry.id).toBe(asset.id); expect(retry.lease_token).not.toBe(first.lease_token);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [first.id, first.lease_token])).toBe(false);
    await db.query('delete from storage.objects where name=$1', [asset.object_key]);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [retry.id, retry.lease_token])).toBe(true);
    expect((await db.query('select file_name,state from dbchat_sqlite_assets where id=$1', [asset.id])).rows[0])
      .toEqual({ file_name: 'deleted.sqlite', state: 'deleted' });
  });
  it('makes attachment atomic with cleanup and forbids cross-owner or duplicate attachment', async () => {
    const asset = await ready();
    await attach('one', asset.object_key);
    await expect(attach('two', asset.object_key)).rejects.toThrow('already attached');
    await expect(attach('foreign', asset.object_key, other)).rejects.toThrow('Register');
    await db.exec("update dbchat_sqlite_assets set expires_at=now()-interval '1 day'");
    expect((await cleanups()).rows).toEqual([]);
    await db.query("delete from dbchat_connections where id='one'");
    const claim = (await cleanups()).rows[0];
    expect(claim.id).toBe(asset.id);
    await expect(attach('late', asset.object_key)).rejects.toThrow('unavailable');
  });
  it('does not delete an attached asset after an old connection is replaced', async () => {
    const first = await ready(); const second = await ready();
    await attach('one', first.object_key);
    await db.query("update dbchat_connections set config=$1 where id='one'", [{ kind: 'sqlite', sqliteObjectKey: second.object_key }]);
    expect((await cleanups()).rows.map(row => row.id)).toEqual([first.id]);
    expect((await db.query("select state from dbchat_sqlite_assets where id=$1", [second.id])).rows[0]).toEqual({ state: 'attached' });
  });
  it('reclaims failed cleanup leases and rejects stale completion tokens', async () => {
    const asset = await ready();
    await db.exec("update dbchat_sqlite_assets set expires_at=now()-interval '1 second'");
    const first = (await cleanups()).rows[0];
    expect((await cleanups()).rows).toEqual([]);
    await db.exec("update dbchat_sqlite_assets set lease_until=now()-interval '1 second'");
    const second = (await cleanups()).rows[0];
    expect(second.id).toBe(asset.id);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [first.id, first.lease_token])).toBe(false);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,false) as result', [second.id, second.lease_token])).toBe(true);
    expect((await db.query('select file_name from dbchat_sqlite_assets where id=$1', [asset.id])).rows[0]).toEqual({ file_name: 'fixture.sqlite' });
    expect((await cleanups()).rows).toEqual([]); // Retry backoff.
  });
  it('checks wall-clock lease expiry even inside an old transaction', async () => {
    const asset = await ready();
    await db.exec("update dbchat_sqlite_assets set expires_at=clock_timestamp()-interval '1 second'");
    const cleanup = (await cleanups()).rows[0];
    await scalar('select dbchat_begin_account_deletion($1) as result', [owner]);
    const deletion = (await db.query<any>('select * from dbchat_claim_account_deletions()')).rows[0];
    await db.exec('begin');
    try {
      await db.exec("update dbchat_sqlite_assets set lease_until=clock_timestamp()+interval '30 milliseconds'; update dbchat_account_deletions set lease_until=clock_timestamp()+interval '30 milliseconds'");
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [asset.id, cleanup.lease_token])).toBe(false);
      expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, deletion.lease_token, 'storage'])).toBe(false);
    } finally { await db.exec('rollback'); }
  });
  it('enforces actual retained bytes without expiring saved files', async () => {
    const first = await begin(randomUUID(), owner, 1073741824);
    expect(first.accepted).toBe(true);
    expect(await begin()).toEqual({ accepted: false, reason: 'retained_bytes' });
    await db.query('update dbchat_sqlite_assets set state=$1,expires_at=null where id=$2', ['attached', first.asset.id]);
    expect(await begin()).toEqual({ accepted: false, reason: 'retained_bytes' });
    expect((await cleanups()).rows).toEqual([]);
    expect((await begin(randomUUID(), other)).accepted).toBe(true);
  });
  it('discovers only old unreferenced legacy objects and never expires saved content', async () => {
    const saved = await ready(); await attach('saved', saved.object_key); await object(saved.object_key);
    const orphan = owner + '/' + randomUUID() + '.sqlite'; await object(orphan);
    const recent = other + '/' + randomUUID() + '.sqlite'; await object(recent, '1 minute');
    await object('unknown-prefix/' + randomUUID() + '.sqlite');
    expect(await scalar('select dbchat_discover_sqlite_orphans() as result')).toBe(1);
    expect((await cleanups()).rows.map(row => row.object_key)).toEqual([orphan]);
    await expect(scalar('select dbchat_discover_sqlite_orphans(1) as result')).rejects.toThrow('bounds');
  });
  it('gates new work immediately, revokes sessions and waits for in-flight upload leases', async () => {
    await db.query("insert into dbchat_sessions values('session',$1,'cipher',1,2,3,0,0,'login')", [owner]);
    await begin();
    await scalar('select dbchat_begin_account_deletion($1) as result', [owner]);
    expect((await db.query('select * from dbchat_sessions')).rows).toEqual([]);
    await expect(begin()).rejects.toThrow('deletion in progress');
    await expect(db.query("insert into dbchat_chats(id,user_id) values('late',$1)", [owner])).rejects.toThrow('deletion in progress');
    const job = (await db.query<any>('select * from dbchat_claim_account_deletions()')).rows[0];
    expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, job.lease_token, 'storage'])).toBe(false);
    await db.exec("update dbchat_sqlite_assets set upload_lease_until=now()-interval '1 second'");
    expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, job.lease_token, 'storage'])).toBe(true);
  });
  it('keeps deletion retryable across Auth cascades and fences a replaced worker', async () => {
    const asset = await ready(); await attach('saved', asset.object_key); await object(asset.object_key);
    await db.query("insert into dbchat_chats(id,user_id,connection_id) values('saved-chat',$1,'saved')", [owner]);
    await scalar('select dbchat_begin_account_deletion($1) as result', [owner]);
    const first = (await db.query<any>('select * from dbchat_claim_account_deletions()')).rows[0];
    await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, first.lease_token, 'storage']);
    await db.query('delete from storage.objects where name=$1', [asset.object_key]);
    await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, first.lease_token, 'auth']);
    expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, first.lease_token, 'complete'])).toBe(false);
    await db.query('delete from auth.users where id=$1', [owner]);
    await db.exec("update dbchat_account_deletions set lease_until=now()-interval '1 second'");
    const next = (await db.query<any>('select * from dbchat_claim_account_deletions()')).rows[0];
    expect(next.phase).toBe('auth');
    expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, first.lease_token, 'complete'])).toBe(false);
    expect(await scalar('select dbchat_advance_account_deletion($1,$2,$3) as result', [owner, next.lease_token, 'complete'])).toBe(true);
    expect((await db.query('select phase from dbchat_account_deletions where owner=$1', [owner])).rows).toEqual([{ phase: 'complete' }]);
    expect((await db.query('select owner,object_key,file_name,bytes,state from dbchat_sqlite_assets where id=$1', [asset.id])).rows[0])
      .toEqual({ owner, object_key: asset.object_key, file_name: 'deleted.sqlite', bytes: 32, state: 'deleted' });
    await object(asset.object_key, '0 seconds');
    const late = (await cleanups()).rows[0];
    expect(late.id).toBe(asset.id); expect(late.object_key).toBe(asset.object_key);
    await db.query('delete from storage.objects where name=$1', [asset.object_key]);
    expect(await scalar('select dbchat_finish_asset_cleanup($1,$2,true) as result', [late.id, late.lease_token])).toBe(true);
    expect((await db.query('select file_name,state from dbchat_sqlite_assets where id=$1', [asset.id])).rows[0])
      .toEqual({ file_name: 'deleted.sqlite', state: 'deleted' });
    await expect(scalar('select dbchat_assert_account_active($1) as result', [owner])).rejects.toThrow('deletion in progress');
  });
  it('denies browser access and allows backend lifecycle calls without Auth table privileges', async () => {
    await db.exec('set role authenticated');
    await expect(begin()).rejects.toThrow('permission denied');
    await expect(db.query('select * from dbchat_sqlite_assets')).rejects.toThrow('permission denied');
    await db.exec('set role service_role');
    expect((await begin()).accepted).toBe(true);
  });
});

const options = { url: 'https://fixture.supabase.co', serviceRoleKey: 'sb_secret_fixture' };
describe('asset lifecycle HTTP and side-effect recovery', () => {
  it('uses the registered key after restart and keeps requests owner scoped', async () => {
    const row = { id: randomUUID(), owner, object_key: owner + '/' + randomUUID() + '.sqlite', file_name: 'fixture.sqlite', bytes: 32, state: 'pending', expires_at: new Date(Date.now() + 60000).toISOString() };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).includes('account_deletions') ? [] : [row]));
    const asset = await new SupabaseAssetLifecycle({ ...options, fetch: fetcher }).resolveUpload(owner, row.id);
    expect(asset.objectKey).toBe(row.object_key);
    expect(String(fetcher.mock.calls[1][0])).toContain('owner=eq.' + owner);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { apikey: options.serviceRoleKey } });
  });
  it.each([false, true])('retries an Auth failure without reopening the account (Auth eventually succeeds=%s)', async succeed => {
    const calls: string[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const name = String(url).split('/').at(-1)!; const body = JSON.parse(String(init?.body)); calls.push(name + ':' + (body.next_phase ?? ''));
      if (name === 'dbchat_discover_sqlite_orphans') return Response.json(0);
      if (name === 'dbchat_claim_asset_cleanup') return Response.json([]);
      if (name === 'dbchat_claim_account_deletions') return Response.json([{ owner, phase: 'auth', lease_token: randomUUID() }]);
      return Response.json(true);
    });
    const storage = { removeOwner: vi.fn(async () => {}) } as unknown as SqliteObjectStorage;
    const deleteAuthUser = vi.fn(async () => { if (!succeed) throw new Error('temporary Auth failure'); });
    const result = await new SupabaseAssetLifecycle({ ...options, fetch: fetcher }).reconcile(storage, { onAccountDeleting: async () => true, cancelExports: async () => true, deleteAuthUser });
    expect(storage.removeOwner).toHaveBeenCalledWith(owner);
    expect(result.accountsCompleted).toBe(succeed ? 1 : 0);
    expect(calls).toContain('dbchat_advance_account_deletion:' + (succeed ? 'complete' : 'retry'));
  });
  it('waits for remote worker/export cleanup before any Storage or Auth deletion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).endsWith('dbchat_claim_account_deletions') ? [{ owner, phase: 'waiting', lease_token: randomUUID() }] : String(url).endsWith('dbchat_claim_asset_cleanup') ? [] : 0));
    const storage = { removeOwner: vi.fn() } as unknown as SqliteObjectStorage;
    const deleteAuthUser = vi.fn();
    const result = await new SupabaseAssetLifecycle({ ...options, fetch: fetcher }).reconcile(storage, { onAccountDeleting: async () => true, cancelExports: async () => false, deleteAuthUser });
    expect(result.pending).toBe(1); expect(storage.removeOwner).not.toHaveBeenCalled(); expect(deleteAuthUser).not.toHaveBeenCalled();
  });
  it.each(['missing', 'lost-response'])('treats an already committed Auth deletion as success (%s)', async mode => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => { if (mode === 'lost-response' && init?.method === 'DELETE') throw new Error('network lost'); return new Response('', { status: 404 }); });
    await expect(deleteSupabaseAuthUser({ ...options, fetch: fetcher }, owner)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(mode === 'missing' ? 1 : 2);
  });
  it('preserves retry state when Auth deletion cannot be confirmed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 503 }));
    await expect(deleteSupabaseAuthUser({ ...options, fetch: fetcher }, owner)).rejects.toThrow('retried automatically');
  });
});
