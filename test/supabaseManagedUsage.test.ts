// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const db = new PGlite();
type Claim = { turnId?: string; created: boolean; quotaExceeded?: string };
const claim = async (id: string, user = owner, managed = true, accountLimit = 2, globalLimit = 3, chat = id) => {
  const result = await db.query<{ result: Claim }>('select public.dbchat_claim_turn_with_limits($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result',
    [user, id, chat, 'request-' + id, { id: 'user-' + id, role: 'user', content: 'Question' }, 'assistant-' + id, managed, accountLimit, globalLimit, { attemptOf: 'old-turn', intent: { action: 'rerun', messageId: 'old-answer' } }]);
  return result.rows[0].result;
};
const usage = async () => (await db.query<{ scope: string; accepted_turns: number }>('select scope,accepted_turns from public.dbchat_managed_usage order by scope')).rows;

describe('managed answer allowance transactions', () => {
  beforeAll(async () => {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key);');
    for (const file of ['202609050001_dbchat_accounts.sql', '202609080001_conversation_recovery.sql', '202610030001_managed_turn_limits.sql', '202610030002_upload_limits.sql']) {
      await db.exec(await readFile(new URL('../supabase/migrations/' + file, import.meta.url), 'utf8'));
    }
  }, 30000);
  beforeEach(async () => {
    await db.exec('reset role; truncate auth.users cascade; truncate public.dbchat_managed_usage, public.dbchat_upload_usage;');
    await db.query('insert into auth.users values ($1),($2)', [owner, other]);
    await db.query("insert into public.dbchat_profiles(user_id,email,display_name) values ($1,'a@example.test','A'),($2,'b@example.test','B')", [owner, other]);
    await db.query("insert into public.dbchat_chats(id,user_id) values ('a',$1),('b',$1),('c',$1),('d',$2),('e',$2)", [owner, other]);
  });
  afterAll(() => db.close());

  it('claims and records retry context atomically, without charging idempotent retries', async () => {
    expect(await claim('a', owner, true, 1)).toEqual({ created: true, turnId: 'a' });
    expect(await claim('a', owner, true, 1)).toEqual({ created: false, turnId: 'a' });
    const turn = (await db.query<{ snapshot: Record<string, unknown> }>("select snapshot from public.dbchat_turns where id='a'")).rows[0].snapshot;
    expect(turn).toMatchObject({ attemptOf: 'old-turn', intent: { action: 'rerun', messageId: 'old-answer' } });
    expect(await usage()).toEqual([{ scope: owner, accepted_turns: 1 }, { scope: 'global', accepted_turns: 1 }]);
  });

  it('rejects an exhausted account before creating any question or turn', async () => {
    await claim('a', owner, true, 1);
    expect(await claim('b', owner, true, 1)).toEqual({ created: false, quotaExceeded: 'account' });
    expect((await db.query("select * from public.dbchat_turns where id='b'")).rows).toHaveLength(0);
    expect((await db.query("select * from public.dbchat_messages where chat_id='b'")).rows).toHaveLength(0);
  });

  it('enforces the global allowance across simultaneous submissions by different accounts', async () => {
    const results = await Promise.all([claim('a', owner, true, 10, 1), claim('d', other, true, 10, 1)]);
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(results.filter(result => result.quotaExceeded === 'global')).toHaveLength(1);
    expect((await usage()).find(row => row.scope === 'global')?.accepted_turns).toBe(1);
  });

  it('does not count personal keys, and never refunds failed or deleted accepted attempts', async () => {
    await claim('a', owner, true, 1, 1);
    await db.query('select public.dbchat_finalize_turn($1,$2,null,$3)', [owner, { id: 'a', status: 'error', events: [], error: 'Model failed' }, []]);
    await db.exec("delete from public.dbchat_chats where id='a'");
    expect(await claim('b', owner, true, 1, 1)).toMatchObject({ quotaExceeded: 'account' });
    expect(await claim('b', owner, false, 1, 1)).toMatchObject({ created: true });
    expect((await usage()).find(row => row.scope === 'global')?.accepted_turns).toBe(1);
    await db.query('delete from auth.users where id=$1', [owner]);
    expect(await claim('d', other, true, 1, 1)).toMatchObject({ quotaExceeded: 'global' });
  });

  it('does not consume allowances on owner or message-identity failures', async () => {
    await expect(claim('a', other)).rejects.toThrow('Chat not found');
    expect(await usage()).toEqual([]);
    await db.query('insert into public.dbchat_messages values($1,$2,0,$3)', [owner, 'a', { id: 'assistant-a', role: 'assistant' }]);
    await expect(claim('a')).rejects.toThrow('Message identifiers must be unique');
    expect(await usage()).toEqual([]);
  });

  it('uses the database UTC day and retains prior-day counters without blocking today', async () => {
    await db.query("insert into public.dbchat_managed_usage values ((now() at time zone 'UTC')::date-1,$1,100),((now() at time zone 'UTC')::date-1,'global',1000)", [owner]);
    expect(await claim('a', owner, true, 1, 1)).toMatchObject({ created: true });
    const today = (await db.query<{ accepted_turns: number }>("select accepted_turns from public.dbchat_managed_usage where usage_day=(now() at time zone 'UTC')::date and scope='global'")).rows;
    expect(today).toEqual([{ accepted_turns: 1 }]);
  });

  it('denies browser access to counters and the owner-bearing claim function', async () => {
    await db.exec('set role authenticated');
    await expect(usage()).rejects.toThrow('permission denied');
    await expect(claim('a')).rejects.toThrow('permission denied');
  });

  it('atomically bounds upload count and bytes across accounts and rejects unknown owners', async () => {
    const reserve = async (user: string, bytes: number, accountCount = 2, globalCount = 3) =>
      (await db.query<{ result: { accepted: boolean } }>('select public.dbchat_reserve_upload($1,$2,$3,$4,100,150) as result', [user, bytes, accountCount, globalCount])).rows[0].result;
    const results = await Promise.all([reserve(owner, 100), reserve(other, 100)]);
    expect(results.filter(result => result.accepted)).toHaveLength(1);
    expect(results.filter(result => !result.accepted)).toHaveLength(1);
    expect(await reserve(owner, 1)).toEqual({ accepted: false });
    expect(await reserve(other, 50, 1)).toEqual({ accepted: true });
    expect(await reserve(other, 1, 1)).toEqual({ accepted: false });
    await expect(reserve('33333333-3333-4333-8333-333333333333', 1)).rejects.toThrow('Account not found');
  });

  it('prunes old aggregate counters while retaining current and previous UTC days', async () => {
    await db.query("insert into public.dbchat_managed_usage select (now() at time zone 'UTC')::date - age,'global',1 from generate_series(0,3) age");
    await db.query("insert into public.dbchat_upload_usage select (now() at time zone 'UTC')::date - age,'global',1,50 from generate_series(0,3) age");
    await db.exec('select public.dbchat_prune_usage()');
    expect((await db.query('select * from public.dbchat_managed_usage')).rows).toHaveLength(2);
    expect((await db.query('select * from public.dbchat_upload_usage')).rows).toHaveLength(2);
  });

  it('runs the maintained isolation regression against all account migrations', async () => {
    await db.exec('truncate auth.users cascade;');
    await db.exec(await readFile(new URL('../supabase/tests/account_isolation.sql', import.meta.url), 'utf8'));
  });
});
