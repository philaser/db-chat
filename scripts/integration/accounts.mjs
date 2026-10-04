import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// Exercise the deployed SQL on independent PostgreSQL sessions. PGlite's single
// connection cannot establish the advisory-lock contention checked here.
const workerCount = 12;
const runId = `${process.pid}-${Date.now()}`;
const container = `db-chat-accounts-integration-${runId}`;
const password = randomBytes(24).toString('base64url');
const owners = [1, 2, 3, 4].map(n => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`);
const unknownOwner = '99999999-9999-4999-8999-999999999999';
const backfillOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clients = new Set();
const checks = [];
let containerStarted = false;
let cleanupPromise;
let currentCheck = 'setup';
let admin;
let locker;
let workers;
let port;
let maxConcurrentWaiters = 0;
const workerIds = new Map();

function docker(args, options = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000, ...options
  }).trim();
}

function cleanup() {
  return cleanupPromise ??= (async () => {
    // Remove only this run's owned container; terminating it also releases any
    // blocked clients after an assertion or interrupt.
    try {
      if (containerStarted) {
        docker(['rm', '-f', container]);
        containerStarted = false;
      }
    } finally {
      await Promise.allSettled([...clients].map(client => client.end()));
    }
  })();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  });
}

async function connect(role) {
  const client = new pg.Client({
    host: '127.0.0.1', port, user: 'postgres', password, database: 'integration',
    application_name: `dbchat-accounts-${runId}`, connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000, query_timeout: 20_000
  });
  clients.add(client);
  // Container teardown can disconnect idle clients during failure cleanup.
  client.on('error', () => {});
  await client.connect();
  if (role) await client.query(`set role ${role}`);
  return client;
}

async function check(name, run) {
  currentCheck = name;
  const detail = await run();
  checks.push({ name, ...detail });
  process.stdout.write(`PASS ${name}: ${JSON.stringify(detail)}\n`);
}

async function resetFixture() {
  await admin.query('truncate auth.users cascade; truncate public.dbchat_managed_usage, public.dbchat_upload_usage');
  await admin.query(`truncate public.dbchat_retained_usage, public.dbchat_retention_reservations,
    public.dbchat_sqlite_assets, public.dbchat_account_deletions;
    delete from public.dbchat_retention_policy where scope<>'project'`);
  for (const worker of workerIds.values()) {
    assert.equal((await admin.query('select public.dbchat_heartbeat_worker($1,120000) as result', [worker])).rows[0].result.alive, true);
  }
  for (const [index, owner] of owners.entries()) {
    await admin.query('insert into auth.users values ($1)', [owner]);
    await admin.query('insert into public.dbchat_profiles(user_id,email,display_name) values ($1,$2,$3)',
      [owner, `fixture-${index}@example.test`, `Fixture ${index}`]);
    for (let chat = 0; chat < workerCount; chat++) {
      await admin.query('insert into public.dbchat_chats(id,user_id) values ($1,$2)', [`chat-${index}-${chat}`, owner]);
    }
  }
}

function turnArgs(index, overrides = {}) {
  return {
    owner: owners[index % owners.length], id: `turn-${index}`, chat: `chat-${index % owners.length}-${index}`,
    request: `request-${index}`, managed: true, accountLimit: 50, globalLimit: 50,
    context: { attemptOf: 'prior-turn', intent: { action: 'rerun', messageId: 'prior-answer' } }, ...overrides
  };
}

async function claim(client, args) {
  const { owner, id, chat, request, managed, accountLimit, globalLimit, context } = args;
  return (await client.query('select public.dbchat_claim_turn_coordinated($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,50,100) as result',
    [owner, id, chat, request, { id: `user-${id}`, role: 'user', content: 'Synthetic question' },
      `assistant-${id}`, managed, accountLimit, globalLimit, context, workerIds.get(client)])).rows[0].result;
}

async function finalize(client, owner, turn, message = null, artifacts = []) {
  return (await client.query('select public.dbchat_finalize_turn_fenced($1,$2,$3,$4,$5) as result',
    [owner, turn, message, JSON.stringify(artifacts), workerIds.get(client)])).rows[0].result;
}

async function reserve(client, owner, limits = {}) {
  const { bytes = 10, accountCount = 50, globalCount = 50, accountBytes = 100_000, globalBytes = 100_000 } = limits;
  return (await client.query('select public.dbchat_reserve_upload($1,$2,$3,$4,$5,$6) as result',
    [owner, bytes, accountCount, globalCount, accountBytes, globalBytes])).rows[0].result;
}

async function counters(table) {
  assert(['managed', 'upload'].includes(table));
  return (await admin.query(`select * from public.dbchat_${table}_usage order by usage_day,scope`)).rows;
}

async function rowCounts() {
  return (await admin.query(`select
    (select count(*)::int from public.dbchat_turns) as turns,
    (select count(*)::int from public.dbchat_messages) as messages,
    (select coalesce(sum(message_count),0)::int from public.dbchat_chats) as chat_messages`)).rows[0];
}

async function retentionPolicy(owner, values) {
  const allowed = new Set(['max_connections', 'max_chats', 'max_messages', 'max_artifacts',
    'max_retained_bytes', 'retained_sqlite_bytes', 'turn_reserve_bytes', 'turn_reserve_artifacts', 'max_sessions', 'max_recovery_sessions']);
  const columns = Object.keys(values);
  assert(columns.every(column => allowed.has(column)));
  await admin.query(`insert into public.dbchat_retention_policy(scope,${columns.join(',')})
    values($1,${columns.map((_, index) => '$' + (index + 2)).join(',')})
    on conflict(scope) do update set ${columns.map(column => `${column}=excluded.${column}`).join(',')}`,
  [owner, ...Object.values(values)]);
}

async function retained(owner) {
  return (await admin.query('select * from public.dbchat_retained_usage where user_id=$1', [owner])).rows[0];
}

async function verifyRetained(owner) {
  const usage = await retained(owner);
  const tables = ['profiles', 'connections', 'chats', 'messages', 'artifacts', 'turns', 'connection_knowledge'];
  const sources = tables.map(table => `select '${table}' as kind,octet_length(to_jsonb(t)::text)::bigint as bytes
    from public.dbchat_${table} t where user_id=$1`).join(' union all ');
  const actual = (await admin.query(`select count(*) filter(where kind='connections') as connection_count,
    count(*) filter(where kind='chats') as chat_count,count(*) filter(where kind='messages') as message_count,
    count(*) filter(where kind='artifacts') as artifact_count,coalesce(sum(bytes),0)::text as retained_bytes
    from (${sources}) records`, [owner])).rows[0];
  for (const field of Object.keys(actual)) assert.equal(usage[field], actual[field], `Ledger mismatch: ${field}`);
  return usage;
}

async function growingWrite(run) {
  try { await run(); return { accepted: true }; }
  catch (error) {
    if (error.code !== 'P0001' || error.message !== 'DBCHAT_RETENTION_LIMIT') throw error;
    return { accepted: false };
  }
}

async function seedBeforeRetentionMigration() {
  await admin.query('insert into auth.users values($1)', [backfillOwner]);
  await admin.query("insert into public.dbchat_profiles(user_id,email,display_name) values($1,'backfill@example.test','Existing fixture')", [backfillOwner]);
  await admin.query(`insert into public.dbchat_connections(id,user_id,config)
    select 'backfill-connection-'||n,$1,'{}'::jsonb from generate_series(0,100) n`, [backfillOwner]);
  await admin.query(`insert into public.dbchat_chats(id,user_id,connection_id,created_at)
    values('backfill-chat',$1,'backfill-connection-0','2000-01-01')`, [backfillOwner]);
  await admin.query("insert into public.dbchat_messages values($1,'backfill-chat',0,'{\"id\":\"old-message\",\"role\":\"user\",\"content\":\"Keep saved content\"}')", [backfillOwner]);
  await admin.query("insert into public.dbchat_artifacts values($1,'backfill-chat',0,'{\"queryId\":\"old-artifact\"}')", [backfillOwner]);
  await admin.query("insert into public.dbchat_turns(id,user_id,chat_id,snapshot,finalized) values('backfill-turn',$1,'backfill-chat','{\"id\":\"backfill-turn\",\"status\":\"complete\"}',true)", [backfillOwner]);
  await admin.query("insert into public.dbchat_connection_knowledge values($1,'backfill-connection-1','{\"glossary\":[],\"examples\":[]}')", [backfillOwner]);
}

async function concurrent(kind, action, owner) {
  const day = (await admin.query("select ((now() at time zone 'UTC')::date)::text as day")).rows[0].day;
  const key = owner ? `dbchat-account:${owner}` : `dbchat-${kind}-usage:${day}`;
  const pids = await Promise.all(workers.map(async client => (await client.query('select pg_backend_pid() as pid')).rows[0].pid));
  assert.equal(new Set(pids).size, workerCount);
  await locker.query('begin');
  await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
  // Start all queries before awaiting any result. Keep rejections handled even
  // if the visibility assertion fails and cleanup releases the blocked queries.
  const pending = workers.map((client, index) => action(client, index));
  const settled = Promise.allSettled(pending);
  let visibilityError;
  let waiting = 0;
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      waiting = (await admin.query(`select count(*)::int as count from pg_stat_activity
        where pid=any($1::int[]) and state='active' and wait_event_type='Lock' and wait_event='advisory'`, [pids])).rows[0].count;
      if (waiting === workerCount) break;
      await delay(20);
    }
    assert.equal(waiting, workerCount, 'All independent sessions must overlap at the advisory lock');
    maxConcurrentWaiters = Math.max(maxConcurrentWaiters, waiting);
  } catch (error) {
    visibilityError = error;
  } finally {
    await locker.query('rollback');
  }
  const results = await settled;
  if (visibilityError) throw visibilityError;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map(result => result.value);
}

async function expireBehindOwnerLock(client, owner, action, assertStartedBeforeExpiry) {
  const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
  await locker.query('begin');
  await locker.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`dbchat-account:${owner}`]);
  const pending = action().then(value => ({ value }), error => ({ error }));
  try {
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      waiting = (await admin.query("select wait_event='advisory' as waiting from pg_stat_activity where pid=$1", [pid])).rows[0]?.waiting;
      if (waiting) break;
      await delay(10);
    }
    assert.equal(waiting, true, 'Operation must be observed waiting before its lease expires');
    await assertStartedBeforeExpiry(pid);
    await delay(1_000);
  } finally { await locker.query('rollback'); }
  return pending;
}

async function expireBehindRowLock(client, table, id, action, assertStartedBeforeExpiry) {
  assert(['dbchat_exports', 'dbchat_sqlite_assets'].includes(table));
  const pid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid;
  const lockerPid = (await locker.query('select pg_backend_pid() as pid')).rows[0].pid;
  await locker.query('begin');
  // Leave the tuple unchanged: an UPDATE would force a predicate recheck and
  // could hide a stale clock evaluated before PostgreSQL waits for this lock.
  await locker.query(`select id from public.${table} where id=$1 for update`, [id]);
  const pending = action().then(value => ({ value }), error => ({ error }));
  try {
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      waiting = (await admin.query(`select wait_event_type='Lock' and wait_event<>'advisory'
        and $2::int=any(pg_blocking_pids(pid)) as waiting from pg_stat_activity where pid=$1`, [pid, lockerPid])).rows[0]?.waiting;
      if (waiting) break;
      await delay(10);
    }
    assert.equal(waiting, true, 'Cleanup must be observed waiting on the unchanged row');
    await assertStartedBeforeExpiry(pid);
    await delay(1_000);
  } finally { await locker.query('rollback'); }
  return pending;
}

async function main() {
  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`, '--env', 'POSTGRES_DB=integration', 'postgres:17-alpine']);
  containerStarted = true;
  port = Number(docker(['port', container, '5432/tcp']).match(/:(\d+)$/)?.[1]);
  assert(Number.isInteger(port) && port > 0, 'Expected a random localhost PostgreSQL port');
  // Probe the published TCP port, which the image's temporary bootstrap server
  // does not listen on, rather than treating bootstrap pg_isready as readiness.
  for (let attempt = 0; attempt < 60; attempt++) {
    try { admin = await connect(); break; }
    catch (error) {
      if (attempt === 59) throw error;
      await delay(250);
    }
  }
  const version = (await admin.query('select version() as version')).rows[0].version;
  assert.match(version, /^PostgreSQL 17\./);
  await admin.query(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id text primary key, bucket_id text references storage.buckets(id), name text,
      metadata jsonb, created_at timestamptz default now());
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to anon,authenticated,service_role;
    create policy fixture_permissive on storage.objects for all to anon,authenticated using(true) with check(true);
  `);
  const migrationDir = new URL('../../supabase/migrations/', import.meta.url);
  const migrations = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
  for (const migration of migrations) {
    currentCheck = `migration ${migration}`;
    if (migration === '202610030005_retention_limits.sql') await seedBeforeRetentionMigration();
    await admin.query(await readFile(new URL(migration, migrationDir), 'utf8'));
  }
  locker = await connect();
  workers = await Promise.all(Array.from({ length: workerCount }, () => connect('service_role')));
  for (const client of workers) {
    const worker = randomUUID();
    workerIds.set(client, worker);
    assert.equal((await client.query('select public.dbchat_register_worker($1,120000) as result', [worker])).rows[0].result.alive, true);
  }
  const backends = await Promise.all([admin, locker, ...workers].map(async client => (await client.query('select pg_backend_pid() as pid')).rows[0].pid));
  assert.equal(new Set(backends).size, workerCount + 2);
  assert.deepEqual((await workers[0].query('select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user')).rows,
    [{ current_user: 'service_role', rolsuper: false, rolbypassrls: true }]);
  process.stdout.write(`PASS migrations: ${JSON.stringify({ migrations, backendSessions: backends.length, workerSessions: workerCount, version })}\n`);

  await check('retention backfill preserves existing over-limit and old saved content', async () => {
    const usage = await verifyRetained(backfillOwner);
    assert.equal(usage.connection_count, '101');
    assert.equal(usage.chat_count, '1');
    assert.equal(usage.message_count, '1');
    assert.equal(usage.artifact_count, '1');
    await assert.rejects(workers[0].query("insert into public.dbchat_connections(id,user_id,config) values('backfill-denied',$1,'{}')", [backfillOwner]), /DBCHAT_RETENTION_LIMIT/);
    await workers[0].query('select public.dbchat_prune_usage()');
    assert.equal((await admin.query("select count(*)::int as count from public.dbchat_chats where id='backfill-chat'")).rows[0].count, 1);
    await workers[0].query("delete from public.dbchat_connections where user_id=$1 and id in ('backfill-connection-0','backfill-connection-1')", [backfillOwner]);
    await workers[0].query("insert into public.dbchat_connections(id,user_id,config) values('backfill-released',$1,'{}')", [backfillOwner]);
    assert.equal((await verifyRetained(backfillOwner)).connection_count, '100');
    assert.equal((await admin.query("select connection_id from public.dbchat_chats where id='backfill-chat'")).rows[0].connection_id, null);
    return { existingConnectionsPreserved: 101, oldChatPreserved: true, growingWriteDenied: true, deletionReleasedCapacity: true, byteLedgerExact: true };
  });

  for (const scenario of [
    { name: 'connections', column: 'max_connections', cap: 3, sql: 'insert into public.dbchat_connections(id,user_id,config) values($1,$2,$3)', body: {} },
    { name: 'chats', column: 'max_chats', cap: 3, sql: 'insert into public.dbchat_chats(id,user_id,source) values($1,$2,$3)', body: {} },
    { name: 'messages', column: 'max_messages', cap: 3, sql: 'insert into public.dbchat_messages(chat_id,user_id,position,body) values($1,$2,0,$3)', body: { role: 'user', content: 'Synthetic retained message' } },
    { name: 'artifacts', column: 'max_artifacts', cap: 2, sql: 'insert into public.dbchat_artifacts(chat_id,user_id,position,body) values($1,$2,0,$3)', body: { queryId: 'synthetic-retained-artifact' } }
  ]) {
    await check(`concurrent per-account retained ${scenario.name} cap`, async () => {
      await resetFixture();
      if (scenario.name === 'chats') await admin.query('delete from public.dbchat_chats where user_id=$1', [owners[0]]);
      await retentionPolicy(owners[0], { [scenario.column]: scenario.cap });
      const results = await concurrent('retention', (client, index) => growingWrite(() => client.query(scenario.sql,
        [scenario.name === 'messages' || scenario.name === 'artifacts' ? `chat-0-${index}` : `retained-${index}`, owners[0], scenario.body])), owners[0]);
      assert.equal(results.filter(row => row.accepted).length, scenario.cap);
      assert.equal(results.filter(row => !row.accepted).length, workerCount - scenario.cap);
      await verifyRetained(owners[0]);
      await workers[0].query("insert into public.dbchat_connections(id,user_id,config) values('independent-other-account',$1,'{}')", [owners[1]]);
      return { submitted: 12, accepted: scenario.cap, rejected: 12 - scenario.cap, otherAccountIndependent: true, byteLedgerExact: true };
    });
  }

  await check('concurrent retained bytes are exact and deletion releases capacity', async () => {
    await resetFixture();
    const before = await retained(owners[0]);
    const config = { label: 'x'.repeat(400) };
    await admin.query('begin');
    await admin.query('insert into public.dbchat_connections(id,user_id,config) values($1,$2,$3)', ['byte-limited-00', owners[0], config]);
    const recordBytes = Number((await retained(owners[0])).retained_bytes) - Number(before.retained_bytes);
    await admin.query('rollback');
    await retentionPolicy(owners[0], { max_retained_bytes: Number(before.retained_bytes) + recordBytes * 2 });
    const results = await concurrent('retention', (client, index) => growingWrite(() => client.query(
      'insert into public.dbchat_connections(id,user_id,config) values($1,$2,$3)',
      [`byte-limited-${String(index).padStart(2, '0')}`, owners[0], config])), owners[0]);
    assert.equal(results.filter(row => row.accepted).length, 2);
    const full = await verifyRetained(owners[0]);
    assert.equal(Number(full.retained_bytes), Number(before.retained_bytes) + recordBytes * 2);
    const existing = (await admin.query('select id from public.dbchat_connections where user_id=$1 order by id', [owners[0]])).rows[0].id;
    await workers[0].query('delete from public.dbchat_connections where user_id=$1 and id=$2', [owners[0], existing]);
    await workers[0].query('insert into public.dbchat_connections(id,user_id,config) values($1,$2,$3)', ['byte-limited-99', owners[0], config]);
    assert.equal((await verifyRetained(owners[0])).retained_bytes, full.retained_bytes);
    return { submitted: 12, accepted: 2, rejected: 10, recordBytes, exactByteBoundary: true, deletionReleasedCapacity: true };
  });

  await check('retention admission denial rolls back the whole managed turn', async () => {
    await resetFixture();
    await retentionPolicy(owners[0], { max_messages: 1 });
    const before = await retained(owners[0]);
    await assert.rejects(claim(workers[0], turnArgs(0)), /DBCHAT_RETENTION_LIMIT/);
    assert.deepEqual(await retained(owners[0]), before);
    assert.deepEqual(await rowCounts(), { turns: 0, messages: 0, chat_messages: 0 });
    assert.deepEqual(await counters('managed'), []);
    assert.equal((await admin.query('select count(*)::int as count from public.dbchat_retention_reservations')).rows[0].count, 0);
    return { partialTurns: 0, partialMessages: 0, chargedManagedTurns: 0, orphanReservations: 0 };
  });

  await check('reserved finalization succeeds above reduced capacity and rejects forged bypasses', async () => {
    await resetFixture();
    assert.equal((await claim(workers[0], turnArgs(0))).created, true);
    const admitted = await retained(owners[0]);
    assert.equal(admitted.reserved_bytes, String(16 * 1024 * 1024));
    assert.equal(admitted.reserved_messages, '1');
    assert.equal(admitted.reserved_artifacts, '8');
    await retentionPolicy(owners[0], { max_retained_bytes: 100, max_messages: 1, max_artifacts: 0 });
    await workers[0].query('begin');
    try {
      await workers[0].query("select set_config('dbchat.retention_finalizing',$1,true)", [`${owners[0]}:turn-0`]);
      await assert.rejects(workers[0].query("update public.dbchat_messages set body=body||'{\"injected\":\"unauthorized growth\"}' where user_id=$1", [owners[0]]), /DBCHAT_RETENTION_LIMIT/);
    } finally { await workers[0].query('rollback'); }
    await assert.rejects(workers[0].query('select public.dbchat_finalize_turn_internal($1,$2,null,$3)',
      [owners[0], { id: 'turn-0', status: 'complete' }, '[]']), error => error.code === '42501');
    await assert.rejects(workers[0].query('insert into public.dbchat_retention_finalizers(backend_pid,transaction_id,user_id,turn_id) values(pg_backend_pid(),txid_current(),$1,$2)',
      [owners[0], 'turn-0']), error => error.code === '42501');
    const result = await finalize(workers[0], owners[0], { id: 'turn-0', status: 'complete', events: [] },
      { id: 'assistant-turn-0', role: 'assistant', content: 'Saved terminal answer' }, [{ queryId: 'saved-terminal-artifact' }]);
    assert.equal(result.status, 'complete');
    const finished = await verifyRetained(owners[0]);
    assert.equal(finished.reserved_bytes, '0');
    assert.equal(finished.reserved_messages, '0');
    assert.equal(finished.reserved_artifacts, '0');
    assert.equal(finished.message_count, '2');
    assert.equal(finished.artifact_count, '1');
    assert(Number(finished.retained_bytes) > 100);
    await assert.rejects(claim(workers[0], turnArgs(1, { owner: owners[0], chat: 'chat-0-1' })), /DBCHAT_RETENTION_LIMIT/);
    await workers[0].query('delete from public.dbchat_chats where user_id=$1 and id=$2', [owners[0], 'chat-0-0']);
    const removed = await verifyRetained(owners[0]);
    assert.equal(removed.message_count, '0');
    assert.equal(removed.artifact_count, '0');
    assert(Number(removed.retained_bytes) < Number(finished.retained_bytes));
    return { reservedBytes: 16 * 1024 * 1024, terminalOverflowCounted: true, forgedSettingDenied: true, privateHelperDenied: true, reservationsReleased: true, deletionAllowedAboveCap: true };
  });

  await check('oversized completions become terminal errors without removing saved evidence', async () => {
    await resetFixture();
    const outcomes = [];
    for (const [index, overflow] of ['bytes', 'artifacts'].entries()) {
      const args = turnArgs(index, { owner: owners[0], chat: `chat-0-${index}` });
      assert.equal((await claim(workers[0], args)).created, true);
      const saved = { id: args.id, status: 'running', question: 'Keep this question',
        message: { role: 'assistant', content: 'Already-saved partial answer' },
        events: [{ id: 7, type: 'status', data: { message: 'Previously saved activity' } }],
        artifacts: [{ queryId: 'previously-saved', note: 'Keep this evidence' }] };
      await workers[0].query('select public.dbchat_save_turn_fenced($1,$2,$3)', [owners[0], saved, workerIds.get(workers[0])]);
      let result;
      if (overflow === 'bytes') {
        result = (await workers[0].query(`select public.dbchat_finalize_turn_fenced($1,
          jsonb_build_object('id',$2::text,'status','complete','message',jsonb_build_object('content',repeat('x',67108864))),null,'[]'::jsonb,$3) as result`,
        [owners[0], args.id, workerIds.get(workers[0])])).rows[0].result;
      } else {
        result = await finalize(workers[0], owners[0], { id: args.id, status: 'complete' },
          { id: `assistant-${args.id}`, role: 'assistant', content: 'Too many artifacts' },
          Array.from({ length: 129 }, (_, artifact) => ({ queryId: `incoming-${artifact}` })));
      }
      assert.equal(result.status, 'error');
      assert.match(result.error, /saved-data completion limit/);
      assert.deepEqual(result.artifacts, saved.artifacts);
      assert.equal(result.question, saved.question);
      assert.equal(result.events.at(-1).type, 'error');
      assert.equal(result.events.at(-1).id, 8);
      assert.match(result.events.at(-1).data.message, /saved-data completion limit/);
      assert.match(result.message.content, /saved-data completion limit/);
      assert.deepEqual(result.retainedMessage, saved.message);
      assert.equal((await admin.query('select finalized from public.dbchat_turns where id=$1', [args.id])).rows[0].finalized, true);
      outcomes.push(overflow);
    }
    assert.equal((await verifyRetained(owners[0])).reserved_bytes, '0');
    assert.equal((await admin.query('select count(*)::int as count from public.dbchat_retention_finalizers')).rows[0].count, 0);
    return { rejectedIncomingEnvelopes: outcomes, terminalErrors: 2, previousEvidencePreserved: true, liveReservations: 0, authorizationRowsLeft: 0 };
  });

  await check('progress and terminal snapshots stay readable without discarding saved evidence', async () => {
    await resetFixture();
    const progressLimit = 14 * 1024 * 1024;
    const terminalLimit = 15 * 1024 * 1024;
    const worker = workerIds.get(workers[0]);
    assert.equal((await claim(workers[0], turnArgs(0))).created, true);
    await workers[0].query(`with base as (select jsonb_build_object('id','turn-0','status','running',
      'question',repeat('q',8388608),'padding','',
      'message',jsonb_build_object('role','assistant','content','Saved partial answer'),
      'artifacts',jsonb_build_array(jsonb_build_object('queryId','saved-proof','note','Keep this evidence')),
      'events',jsonb_build_array(jsonb_build_object('id',7,'type','status','data',jsonb_build_object('message','Saved activity')))) as doc)
      select public.dbchat_save_turn_fenced($1,doc||jsonb_build_object('padding',repeat('x',$3::integer-octet_length(doc::text))),$2) from base`,
    [owners[0], worker, progressLimit]);
    const state = async id => (await admin.query(`select finalized,octet_length(snapshot::text) as bytes,md5(snapshot::text) as digest,
      md5(snapshot->>'question') as question,md5(snapshot->>'padding') as padding,snapshot->'artifacts' as artifacts,
      snapshot->'message' as message from public.dbchat_turns where id=$1`, [id])).rows[0];
    const before = await state('turn-0');
    const usage = await retained(owners[0]);
    assert.equal(before.bytes, progressLimit);
    await assert.rejects(workers[0].query(`select public.dbchat_save_turn_fenced($1,
      snapshot||jsonb_build_object('padding',(snapshot->>'padding')||'x'),$2)
      from public.dbchat_turns where id='turn-0'`, [owners[0], worker]), /DBCHAT_SAVED_READ_LIMIT/);
    assert.deepEqual(await state('turn-0'), before);
    assert.deepEqual(await retained(owners[0]), usage);
    const fallback = (await workers[0].query(`with base as (
      select snapshot||jsonb_build_object('status','complete','padding','') as doc from public.dbchat_turns where id='turn-0'
    ), completed as materialized (
      select public.dbchat_finalize_turn_fenced($1,doc||jsonb_build_object('padding',repeat('x',$3::integer-octet_length(doc::text))),null,'[]'::jsonb,$2) as doc from base
    ) select doc->>'status' as status,doc->>'error' as error,octet_length(doc::text) as bytes,
      doc->'retainedMessage' as retained_message,doc->'events'->-1->>'type' as event_type,
      (doc->'events'->-1->>'id')::integer as event_id,length(doc->'message'->'turn'->>'question') as copied_question from completed`,
    [owners[0], worker, terminalLimit + 1])).rows[0];
    assert.equal(fallback.status, 'error');
    assert.match(fallback.error, /saved-data completion limit/);
    assert(fallback.bytes < terminalLimit);
    assert.equal(fallback.copied_question, 8000);
    assert.equal(fallback.event_type, 'error');
    assert.equal(fallback.event_id, 8);
    assert.deepEqual(fallback.retained_message, before.message);
    const after = await state('turn-0');
    assert.equal(after.finalized, true);
    for (const field of ['question', 'padding', 'artifacts']) assert.deepEqual(after[field], before[field]);
    assert.equal((await verifyRetained(owners[0])).reserved_bytes, '0');

    assert.equal((await claim(workers[0], turnArgs(1, { owner: owners[0], chat: 'chat-0-1' }))).created, true);
    const accepted = (await workers[0].query(`with base as (
      select jsonb_build_object('id','turn-1','status','complete','events','[]'::jsonb,'padding','',
        'message',jsonb_build_object('role','assistant','content','Normal terminal answer')) as doc
    ), completed as materialized (
      select public.dbchat_finalize_turn_fenced($1,doc||jsonb_build_object('padding',repeat('x',$3::integer-octet_length(doc::text))),doc->'message','[]'::jsonb,$2) as doc from base
    ) select doc->>'status' as status,octet_length(doc::text) as bytes from completed`,
    [owners[0], worker, terminalLimit])).rows[0];
    assert.deepEqual(accepted, { status: 'complete', bytes: terminalLimit });

    // The base helper adds a synthesized assistant message for errors. Its final
    // stored size, not just the incoming turn size, must obey the same ceiling.
    assert.equal((await claim(workers[0], turnArgs(2, { owner: owners[0], chat: 'chat-0-2' }))).created, true);
    const synthesized = (await workers[0].query(`with base as (
      select jsonb_build_object('id','turn-2','status','error','error',repeat('e',1048576),'events','[]'::jsonb,'padding','') as doc
    ), completed as materialized (
      select public.dbchat_finalize_turn_fenced($1,doc||jsonb_build_object('padding',repeat('x',$3::integer-octet_length(doc::text))),null,'[]'::jsonb,$2) as doc from base
    ) select doc->>'status' as status,doc->>'error' as error,octet_length(doc::text) as bytes from completed`,
    [owners[0], worker, terminalLimit])).rows[0];
    assert.equal(synthesized.status, 'error');
    assert.match(synthesized.error, /saved-data completion limit/);
    assert(synthesized.bytes < terminalLimit);
    assert.equal((await admin.query("select count(*)::int as count from public.dbchat_messages where chat_id='chat-0-2' and body->>'role'='assistant'")).rows[0].count, 1);

    // Simulate an existing deployment's large snapshot; no maintenance pass or
    // rejected save may delete or truncate it to satisfy the new read ceiling.
    assert.equal((await claim(workers[0], turnArgs(3, { owner: owners[0], chat: 'chat-0-3' }))).created, true);
    await admin.query("update public.dbchat_turns set snapshot=snapshot||jsonb_build_object('legacyEvidence',repeat('z',17825792)) where id='turn-3'");
    const legacy = await state('turn-3');
    await assert.rejects(workers[0].query("select public.dbchat_save_turn_fenced($1,snapshot,$2) from public.dbchat_turns where id='turn-3'", [owners[0], worker]), /DBCHAT_SAVED_READ_LIMIT/);
    await workers[0].query('select public.dbchat_prune_usage()');
    assert.deepEqual(await state('turn-3'), legacy);
    await verifyRetained(owners[0]);
    return { progressBoundaryBytes: progressLimit, rejectedProgressGrowth: 1, terminalBoundaryBytes: terminalLimit,
      oversizedTerminalBelow64MiBBecomesError: true, synthesizedMessageRollback: true,
      savedEvidencePreserved: true, legacySnapshotUnchanged: true };
  });

  await check('retained SQLite bytes serialize across workers and rejected attachments roll back', async () => {
    await resetFixture();
    await retentionPolicy(owners[0], { retained_sqlite_bytes: 100, max_connections: 0 });
    assert.equal((await workers[0].query('select public.dbchat_retained_sqlite_limit($1) as bytes', [owners[1]])).rows[0].bytes, String(1024 * 1024 * 1024));
    const results = await concurrent('assets', async client => (await client.query(
      "select public.dbchat_begin_sqlite_upload($1,$2,'fixture.sqlite',20) as result", [owners[0], randomUUID()])).rows[0].result, owners[0]);
    assert.equal(results.filter(row => row.accepted).length, 5);
    assert.equal(results.filter(row => !row.accepted).length, 7);
    assert.equal((await admin.query("select sum(bytes)::text as bytes from public.dbchat_sqlite_assets where owner=$1 and state<>'deleted'", [owners[0]])).rows[0].bytes, '100');
    const asset = results.find(row => row.accepted).asset;
    await workers[0].query('select public.dbchat_complete_sqlite_upload($1,$2)', [owners[0], asset.id]);
    await assert.rejects(workers[0].query('insert into public.dbchat_connections(id,user_id,config) values($1,$2,$3)',
      ['denied-asset-attachment', owners[0], { kind: 'sqlite', sqliteObjectKey: asset.object_key }]), /DBCHAT_RETENTION_LIMIT/);
    assert.equal((await admin.query('select state from public.dbchat_sqlite_assets where id=$1', [asset.id])).rows[0].state, 'pending');
    assert.equal((await verifyRetained(owners[0])).connection_count, '0');
    return { submitted: 12, accepted: 5, rejected: 7, retainedBytes: 100, failedConnectionLeavesAssetPending: true };
  });

  await check('maintenance deletes only expired sessions and account deletion removes the retained ledger', async () => {
    await resetFixture();
    const now = Date.now();
    for (const [id, idle, absolute] of [['expired-idle', now - 1000, now + 60000], ['expired-absolute', now + 60000, now - 1000], ['live-session', now + 60000, now + 60000]]) {
      await admin.query(`insert into public.dbchat_sessions(id_hash,user_id,encrypted_tokens,access_expires_at,expires_at,absolute_expires_at,refreshed_at)
        values($1,$2,'synthetic-ciphertext',$3,$4,$5,$3)`, [id, owners[0], now, idle, absolute]);
    }
    const before = await retained(owners[0]);
    await workers[0].query('select public.dbchat_prune_usage()');
    assert.deepEqual((await admin.query('select id_hash from public.dbchat_sessions order by id_hash')).rows, [{ id_hash: 'live-session' }]);
    assert.deepEqual(await retained(owners[0]), before);
    await admin.query('delete from auth.users where id=$1', [owners[0]]);
    assert.equal(await retained(owners[0]), undefined);
    assert.equal((await admin.query('select count(*)::int as count from public.dbchat_retention_reservations where user_id=$1', [owners[0]])).rows[0].count, 0);
    await verifyRetained(owners[1]);
    return { expiredSessionsRemoved: 2, liveSessionsPreserved: 1, savedRowsUnchangedByPruning: true, deletedAccountLedgerRemoved: true, otherOwnerPreserved: true };
  });

  await check('live sessions have concurrent account caps and separate bounded recovery slots', async () => {
    await resetFixture();
    const insertSession = async (client, id, purpose = 'login') => {
      try {
        await client.query(`insert into public.dbchat_sessions(id_hash,user_id,encrypted_tokens,access_expires_at,expires_at,absolute_expires_at,refreshed_at,purpose)
          values($1,$2,'synthetic-ciphertext',0,$3,$3,0,$4)`, [id, owners[0], Date.now() + 60_000, purpose]);
        return { accepted: true };
      } catch (error) {
        if (error.code !== 'P0001' || error.message !== 'DBCHAT_SESSION_LIMIT') throw error;
        return { accepted: false };
      }
    };
    const first = await concurrent('sessions', (client, index) => insertSession(client, `login-first-${index}`), owners[0]);
    const second = await concurrent('sessions', (client, index) => insertSession(client, `login-second-${index}`), owners[0]);
    assert.equal([...first, ...second].filter(row => row.accepted).length, 20);
    const recovery = await concurrent('sessions', (client, index) => insertSession(client, `recovery-${index}`, 'recovery'), owners[0]);
    assert.equal(recovery.filter(row => row.accepted).length, 2);
    const preserved = (await admin.query("select id_hash from public.dbchat_sessions where purpose='login' order by id_hash")).rows.map(row => row.id_hash);
    assert.equal(preserved.length, 20);
    await admin.query('update public.dbchat_sessions set expires_at=0 where id_hash=any($1::text[])', [preserved.slice(0, 2)]);
    assert.deepEqual(await insertSession(workers[0], 'after-expired-cleanup'), { accepted: true });
    const live = (await admin.query("select id_hash from public.dbchat_sessions where purpose='login' order by id_hash")).rows.map(row => row.id_hash);
    assert.deepEqual(live, [...preserved.slice(2), 'after-expired-cleanup'].sort());
    await retentionPolicy(owners[0], { max_sessions: 1 });
    await workers[0].query('update public.dbchat_sessions set refreshed_at=1 where id_hash=$1', [live[0]]);
    assert.deepEqual(await insertSession(workers[0], 'above-reduced-session-cap'), { accepted: false });
    assert.equal((await admin.query('select count(*)::int as count from public.dbchat_sessions')).rows[0].count, 21);
    return { simultaneousLoginAttempts: 24, admittedLogins: 20, recoveryAttempts: 12, admittedRecoverySessions: 2, expiredCleanedBeforeAdmission: 2, liveSessionsEvicted: 0, existingRefreshAllowedAfterPolicyReduction: true };
  });

  await check('chat metadata and deletion acquire owner locks before chat row locks', async () => {
    for (const operation of ['update', 'delete']) {
      await resetFixture();
      const claimPid = (await workers[0].query('select pg_backend_pid() as pid')).rows[0].pid;
      const mutationPid = (await workers[1].query('select pg_backend_pid() as pid')).rows[0].pid;
      const lockerPid = (await locker.query('select pg_backend_pid() as pid')).rows[0].pid;
      await locker.query('begin');
      await locker.query("select id from public.dbchat_chats where id='chat-0-0' for update");
      const accepted = claim(workers[0], turnArgs(0)).then(value => ({ value }), error => ({ error }));
      let mutation;
      try {
        let claimBlocked = false;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          claimBlocked = (await admin.query('select $2::int=any(pg_blocking_pids($1)) as blocked', [claimPid, lockerPid])).rows[0].blocked;
          if (claimBlocked) break;
          await delay(10);
        }
        assert.equal(claimBlocked, true, 'Claim must hold its owner lock while blocked on the chat row');
        mutation = workers[1].query(operation === 'update'
          ? "select public.dbchat_update_chat($1,'chat-0-0','{\"title\":\"Concurrent edit\"}')"
          : "select public.dbchat_delete_chat($1,'chat-0-0')", [owners[0]]).then(value => ({ value }), error => ({ error }));
        let ownerBlocked = false;
        const mutationDeadline = Date.now() + 5_000;
        while (Date.now() < mutationDeadline) {
          ownerBlocked = (await admin.query("select wait_event='advisory' and $2::int=any(pg_blocking_pids(pid)) as blocked from pg_stat_activity where pid=$1", [mutationPid, claimPid])).rows[0]?.blocked;
          if (ownerBlocked) break;
          await delay(10);
        }
        assert.equal(ownerBlocked, true, 'Mutation must wait for the owner before trying to lock the chat row');
      } finally { await locker.query('rollback'); }
      const claimResult = await accepted;
      assert.ifError(claimResult.error);
      assert.equal(claimResult.value.created, true);
      const mutationResult = await mutation;
      assert.ifError(mutationResult.error);
      await verifyRetained(owners[0]);
      if (operation === 'delete') assert.equal((await retained(owners[0])).reserved_bytes, '0');
    }
    return { operations: ['metadata update', 'chat deletion'], ownerBeforeRowVerified: true, deadlocks: 0, byteLedgerExact: true };
  });

  await check('export heartbeat and publication reject leases that expire while waiting for a lock', async () => {
    await resetFixture();
    for (const operation of ['tick', 'finish']) {
      const id = randomUUID();
      const worker = workerIds.get(workers[0]);
      await admin.query(`insert into public.dbchat_exports(id,user_id,chat_id,worker_id,title,format,scope,status,executing,limits,object_key,expires_at,lease_until)
        values($1::uuid,$2::uuid,'chat-0-0',$3::uuid,'Synthetic export','csv','all','running',true,
          '{"maxBytes":1000,"maxRows":1000,"timeoutMs":1000,"ttlMs":3600000}',
          $2::uuid::text||'/'||$1::uuid::text||'.export',clock_timestamp()+interval '1 hour',clock_timestamp()+interval '700 milliseconds')`,
      [id, owners[0], worker]);
      const result = await expireBehindOwnerLock(workers[0], owners[0],
        () => workers[0].query(operation === 'tick'
          ? 'select public.dbchat_export_tick($1,$2,false) as result'
          : "select public.dbchat_export_finish($1,$2,'ready',1,1) as result", [id, worker]),
        async pid => assert.equal((await admin.query('select a.query_start<e.lease_until as timely from pg_stat_activity a,public.dbchat_exports e where a.pid=$1 and e.id=$2', [pid, id])).rows[0].timely, true));
      if (operation === 'tick') {
        assert.ifError(result.error);
        assert.equal(result.value.rows[0].result, null);
      } else assert.match(result.error?.message ?? '', /lease lost/i);
      assert.equal((await admin.query('select status from public.dbchat_exports where id=$1', [id])).rows[0].status, 'running');
    }
    return { operations: ['tick', 'finish'], observedBlockedBeforeExpiry: true, expiredHeartbeatRejected: true, expiredPublicationRejected: true };
  });

  await check('export cleanup rejects an acknowledgment after an unchanged row lock outlives its lease', async () => {
    await resetFixture();
    const id = randomUUID();
    const token = randomUUID();
    await admin.query(`insert into public.dbchat_exports(id,user_id,chat_id,worker_id,title,format,scope,status,limits,object_key,expires_at,lease_until,cleanup_token,cleanup_until)
      values($1::uuid,$2::uuid,'chat-0-0',$3::uuid,'Synthetic cleanup','csv','all','error',
        '{"maxBytes":1000,"maxRows":1000,"timeoutMs":1000,"ttlMs":3600000}',
        $2::uuid::text||'/'||$1::uuid::text||'.export',clock_timestamp()-interval '1 second',clock_timestamp(),$4::uuid,clock_timestamp()+interval '700 milliseconds')`,
    [id, owners[0], workerIds.get(workers[0]), token]);
    const before = (await admin.query('select * from public.dbchat_exports where id=$1', [id])).rows[0];
    const result = await expireBehindRowLock(workers[0], 'dbchat_exports', id,
      () => workers[0].query('select public.dbchat_export_cleanup_finish($1,$2)', [id, token]),
      async pid => assert.equal((await admin.query('select a.query_start<e.cleanup_until as timely from pg_stat_activity a,public.dbchat_exports e where a.pid=$1 and e.id=$2', [pid, id])).rows[0].timely, true));
    assert.ifError(result.error);
    assert.deepEqual((await admin.query('select * from public.dbchat_exports where id=$1', [id])).rows[0], before,
      'Expired cleanup acknowledgment must leave the row and tombstone unchanged');
    await admin.query("update public.dbchat_exports set cleanup_until=clock_timestamp()+interval '1 minute' where id=$1", [id]);
    const live = (await admin.query('select * from public.dbchat_exports where id=$1', [id])).rows[0];
    for (const invalidToken of [null, randomUUID()]) {
      await workers[0].query('select public.dbchat_export_cleanup_finish($1,$2)', [id, invalidToken]);
      assert.deepEqual((await admin.query('select * from public.dbchat_exports where id=$1', [id])).rows[0], live);
    }
    await workers[0].query('select public.dbchat_export_cleanup_finish($1,$2)', [id, token]);
    const accepted = (await admin.query('select object_deleted,cleanup_token,tombstone_until from public.dbchat_exports where id=$1', [id])).rows[0];
    assert.equal(accepted.object_deleted, true);
    assert.equal(accepted.cleanup_token, null);
    assert(accepted.tombstone_until instanceof Date);
    return { unchangedRowBlockObserved: true, staleAcknowledgmentIgnored: true, invalidTokensIgnored: true, liveLeaseAcknowledgmentAccepted: true };
  });

  await check('asset cleanup rejects an acknowledgment after an unchanged row lock outlives its lease', async () => {
    await resetFixture();
    const id = randomUUID();
    const token = randomUUID();
    await workers[0].query("select public.dbchat_begin_sqlite_upload($1,$2,'cleanup.sqlite',20)", [owners[0], id]);
    await admin.query("update public.dbchat_sqlite_assets set state='deleting',lease_token=$2,lease_until=clock_timestamp()+interval '700 milliseconds' where id=$1", [id, token]);
    const before = (await admin.query('select * from public.dbchat_sqlite_assets where id=$1', [id])).rows[0];
    const result = await expireBehindRowLock(workers[0], 'dbchat_sqlite_assets', id,
      () => workers[0].query('select public.dbchat_finish_asset_cleanup($1,$2,true) as accepted', [id, token]),
      async pid => assert.equal((await admin.query('select a.query_start<s.lease_until as timely from pg_stat_activity a,public.dbchat_sqlite_assets s where a.pid=$1 and s.id=$2', [pid, id])).rows[0].timely, true));
    assert.ifError(result.error);
    assert.equal(result.value.rows[0].accepted, false);
    assert.deepEqual((await admin.query('select * from public.dbchat_sqlite_assets where id=$1', [id])).rows[0], before);
    await admin.query("update public.dbchat_sqlite_assets set lease_until=clock_timestamp()+interval '1 minute' where id=$1", [id]);
    assert.equal((await workers[0].query('select public.dbchat_finish_asset_cleanup($1,$2,true) as accepted', [id, token])).rows[0].accepted, true);
    assert.equal((await admin.query('select state from public.dbchat_sqlite_assets where id=$1', [id])).rows[0].state, 'deleted');
    return { unchangedRowBlockObserved: true, staleAcknowledgmentRejected: true, liveLeaseAcknowledgmentAccepted: true };
  });

  await check('upload completion rechecks its lease after waiting for the account lock', async () => {
    await resetFixture();
    const id = randomUUID();
    await workers[0].query("select public.dbchat_begin_sqlite_upload($1,$2,'lease.sqlite',20)", [owners[0], id]);
    await admin.query("update public.dbchat_sqlite_assets set upload_lease_until=clock_timestamp()+interval '700 milliseconds' where id=$1", [id]);
    const result = await expireBehindOwnerLock(workers[0], owners[0],
      () => workers[0].query('select public.dbchat_complete_sqlite_upload($1,$2)', [owners[0], id]),
      async pid => assert.equal((await admin.query('select a.query_start<s.upload_lease_until as timely from pg_stat_activity a,public.dbchat_sqlite_assets s where a.pid=$1 and s.id=$2', [pid, id])).rows[0].timely, true));
    assert.match(result.error?.message ?? '', /Upload has expired/);
    assert.equal((await admin.query('select state from public.dbchat_sqlite_assets where id=$1', [id])).rows[0].state, 'uploading');
    return { observedBlockedBeforeExpiry: true, expiredUploadCompletionRejected: true };
  });

  await check('turn finalization fences a worker whose lease expires while blocked', async () => {
    await resetFixture();
    assert.equal((await claim(workers[0], turnArgs(0))).created, true);
    const worker = workerIds.get(workers[0]);
    await admin.query("update public.dbchat_workers set lease_until=clock_timestamp()+interval '700 milliseconds' where id=$1", [worker]);
    const result = await expireBehindOwnerLock(workers[0], owners[0],
      () => finalize(workers[0], owners[0], { id: 'turn-0', status: 'complete' }, { role: 'assistant', content: 'Stale worker result' }),
      async pid => assert.equal((await admin.query('select a.query_start<w.lease_until as timely from pg_stat_activity a,public.dbchat_workers w where a.pid=$1 and w.id=$2', [pid, worker])).rows[0].timely, true));
    assert.match(result.error?.message ?? '', /DBCHAT_WORKER_FENCED/);
    assert.equal((await admin.query("select finalized from public.dbchat_turns where id='turn-0'")).rows[0].finalized, false);
    assert.equal((await workers[1].query('select public.dbchat_recover_turn($1,$2) as recovered', [owners[0], 'turn-0'])).rows[0].recovered, true);
    assert.equal((await admin.query("select snapshot->>'status' as status from public.dbchat_turns where id='turn-0'")).rows[0].status, 'error');
    assert.equal((await verifyRetained(owners[0])).reserved_bytes, '0');
    const replacement = randomUUID();
    assert.equal((await workers[0].query('select public.dbchat_register_worker($1,120000) as result', [replacement])).rows[0].result.alive, true);
    workerIds.set(workers[0], replacement);
    return { observedBlockedBeforeExpiry: true, staleFinalizationRejected: true, recoveredTerminalError: true, completionReservationReleased: true };
  });

  await check('managed global cap across concurrent accounts', async () => {
    await resetFixture();
    const results = await concurrent('managed', (client, index) => claim(client, turnArgs(index, { globalLimit: 3 })));
    assert.equal(results.filter(row => row.created).length, 3);
    assert.equal(results.filter(row => row.quotaExceeded === 'global').length, 9);
    const usage = await counters('managed');
    assert.equal(usage.find(row => row.scope === 'global').accepted_turns, 3);
    assert.equal(usage.filter(row => row.scope !== 'global').reduce((sum, row) => sum + row.accepted_turns, 0), 3);
    assert.deepEqual(await rowCounts(), { turns: 3, messages: 3, chat_messages: 3 });
    return { submitted: 12, accepted: 3, rejected: 9, storedTurns: 3, storedMessages: 3 };
  });

  await check('managed account cap across concurrent chats', async () => {
    await resetFixture();
    const results = await concurrent('managed', (client, index) => claim(client,
      turnArgs(index, { owner: owners[0], chat: `chat-0-${index}`, accountLimit: 2 })));
    assert.equal(results.filter(row => row.created).length, 2);
    assert.equal(results.filter(row => row.quotaExceeded === 'account').length, 10);
    assert.deepEqual((await counters('managed')).map(row => [row.scope, row.accepted_turns]), [[owners[0], 2], ['global', 2]]);
    assert.deepEqual(await rowCounts(), { turns: 2, messages: 2, chat_messages: 2 });
    return { submitted: 12, accepted: 2, rejected: 10, storedTurns: 2, storedMessages: 2 };
  });

  await check('concurrent request retries charge once at the exact quota', async () => {
    await resetFixture();
    const args = turnArgs(0, { accountLimit: 1, globalLimit: 1 });
    const results = await concurrent('managed', (client, index) => claim(client, { ...args, id: `candidate-${index}` }));
    assert.equal(results.filter(row => row.created).length, 1);
    assert.equal(results.filter(row => !row.created && !row.quotaExceeded).length, 11);
    const turnId = results.find(row => row.created).turnId;
    assert(results.every(row => row.turnId === turnId));
    assert.deepEqual(await claim(workers[0], { ...args, id: 'later-retry' }), { created: false, turnId });
    assert.deepEqual((await counters('managed')).map(row => row.accepted_turns), [1, 1]);
    assert.deepEqual(await rowCounts(), { turns: 1, messages: 1, chat_messages: 1 });
    const snapshot = (await admin.query('select snapshot from public.dbchat_turns where id=$1', [turnId])).rows[0].snapshot;
    assert.equal(snapshot.attemptOf, args.context.attemptOf);
    assert.deepEqual(snapshot.intent, args.context.intent);
    await assert.rejects(claim(workers[0], { ...args, chat: 'chat-0-1' }), /Request belongs to another chat/);
    return { simultaneousRetries: 12, created: 1, duplicateResults: 11, laterRetryCharged: false, storedTurns: 1 };
  });

  for (const scenario of [
    { name: 'account upload count', singleOwner: true, limits: { accountCount: 3 }, accepted: 3, bytes: 30 },
    { name: 'global upload count', singleOwner: false, limits: { globalCount: 3 }, accepted: 3, bytes: 30 },
    { name: 'account upload bytes', singleOwner: true, limits: { bytes: 40, accountBytes: 100 }, accepted: 2, bytes: 80 },
    { name: 'global upload bytes', singleOwner: false, limits: { bytes: 40, globalBytes: 100 }, accepted: 2, bytes: 80 }
  ]) {
    await check(`${scenario.name} under concurrent reservations`, async () => {
      await resetFixture();
      const results = await concurrent('upload', (client, index) => reserve(client,
        owners[scenario.singleOwner ? 0 : index % owners.length], scenario.limits));
      assert.equal(results.filter(row => row.accepted).length, scenario.accepted);
      assert.equal(results.filter(row => !row.accepted).length, workerCount - scenario.accepted);
      const usage = await counters('upload');
      const global = usage.find(row => row.scope === 'global');
      assert.equal(global.accepted_uploads, scenario.accepted);
      assert.equal(Number(global.reserved_bytes), scenario.bytes);
      assert.equal(usage.filter(row => row.scope !== 'global').reduce((sum, row) => sum + row.accepted_uploads, 0), scenario.accepted);
      assert.equal(usage.filter(row => row.scope !== 'global').reduce((sum, row) => sum + Number(row.reserved_bytes), 0), scenario.bytes);
      if (scenario.singleOwner) assert.equal(usage.find(row => row.scope === owners[0]).accepted_uploads, scenario.accepted);
      // Fill the remaining byte allowance exactly, then reject one more byte.
      if (scenario.bytes === 80) {
        assert.deepEqual(await reserve(workers[0], owners[0], { ...scenario.limits, bytes: 20 }), { accepted: true });
        assert.deepEqual(await reserve(workers[0], owners[0], { ...scenario.limits, bytes: 1 }), { accepted: false });
        const exact = (await counters('upload')).find(row => row.scope === 'global');
        assert.equal(exact.reserved_bytes, '100');
        assert.equal(exact.accepted_uploads, 3);
      }
      return { submitted: 12, accepted: scenario.accepted, rejected: 12 - scenario.accepted, reservedBytes: scenario.bytes, exactByteBoundary: scenario.bytes === 80 };
    });
  }

  await check('tenant and identity failures leave counters unchanged', async () => {
    await resetFixture();
    await assert.rejects(claim(workers[0], turnArgs(0, { owner: owners[1] })), /Chat not found/);
    await assert.rejects(reserve(workers[0], unknownOwner), /Account not found/);
    await admin.query('insert into public.dbchat_messages values($1,$2,0,$3)',
      [owners[0], 'chat-0-0', { id: 'assistant-turn-0', role: 'assistant' }]);
    await assert.rejects(claim(workers[0], turnArgs(0)), /Message identifiers must be unique/);
    assert.deepEqual(await counters('managed'), []);
    assert.deepEqual(await counters('upload'), []);
    assert.equal((await rowCounts()).turns, 0);
    return { rejectedCrossOwnerClaim: true, rejectedUnknownUploadOwner: true, rejectedMessageCollision: true, quotaRows: 0 };
  });

  await check('transaction failure rolls back turns, messages and both quotas', async () => {
    await resetFixture();
    const client = workers[0];
    await client.query('begin');
    try {
      assert.equal((await claim(client, turnArgs(0))).created, true);
      assert.deepEqual(await reserve(client, owners[0]), { accepted: true });
      await assert.rejects(client.query('select 1/0'), error => error.code === '22012');
    } finally { await client.query('rollback'); }
    assert.deepEqual(await counters('managed'), []);
    assert.deepEqual(await counters('upload'), []);
    assert.deepEqual(await rowCounts(), { turns: 0, messages: 0, chat_messages: 0 });
    assert.equal((await claim(client, turnArgs(0))).created, true);
    assert.deepEqual(await reserve(client, owners[0]), { accepted: true });
    return { rolledBackTurns: 1, rolledBackUploadReservations: 1, persistedBeforeRetry: 0, retryAccepted: true };
  });

  await check('failed attempts and account deletion do not refund usage', async () => {
    await resetFixture();
    assert.equal((await claim(workers[0], turnArgs(0, { globalLimit: 1 }))).created, true);
    assert.deepEqual(await reserve(workers[0], owners[0], { globalCount: 1 }), { accepted: true });
    await finalize(workers[0], owners[0], { id: 'turn-0', status: 'error', events: [], error: 'Synthetic model failure' });
    assert.equal((await claim(workers[0], turnArgs(1, { managed: false, globalLimit: 1 }))).created, true);
    await admin.query('delete from auth.users where id=$1', [owners[0]]);
    assert.deepEqual(await claim(workers[0], turnArgs(2, { globalLimit: 1 })), { created: false, quotaExceeded: 'global' });
    assert.deepEqual(await reserve(workers[0], owners[2], { globalCount: 1 }), { accepted: false });
    assert.deepEqual((await counters('managed')).map(row => row.accepted_turns), [1, 1]);
    assert.deepEqual((await counters('upload')).map(row => [row.accepted_uploads, row.reserved_bytes]), [[1, '10'], [1, '10']]);
    return { managedGlobal: 1, uploadGlobal: 1, personalKeyCharged: false, deletionRefunded: false };
  });

  await check('browser roles cannot read counters or invoke owner-bearing functions', async () => {
    for (const role of ['anon', 'authenticated']) {
      const tableAccess = (await admin.query(`select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and relkind='r' and relname like 'dbchat_%'
        and (not relrowsecurity or has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE'))`, [role])).rows;
      assert.deepEqual(tableAccess, [], `${role} must have neither table grants nor disabled RLS`);
      const functionAccess = (await admin.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname like 'dbchat_%' and has_function_privilege($1,p.oid,'EXECUTE')`, [role])).rows;
      assert.deepEqual(functionAccess, [], `${role} must not invoke server-only functions`);
      const client = workers[0];
      await client.query(`set role ${role}`);
      try {
        for (const table of ['dbchat_managed_usage', 'dbchat_upload_usage']) {
          await assert.rejects(client.query(`select * from public.${table}`), error => error.code === '42501');
        }
        await assert.rejects(claim(client, turnArgs(0)), error => error.code === '42501');
        await assert.rejects(reserve(client, owners[0]), error => error.code === '42501');
        await assert.rejects(client.query('select public.dbchat_prune_usage()'), error => error.code === '42501');
      } finally { await client.query('set role service_role'); }
    }
    return { roles: ['anon', 'authenticated'], tableGrants: 0, executableServerFunctions: 0, actualDeniedCalls: 10 };
  });

  await check('private SQLite storage denies permissive browser policy access', async () => {
    await admin.query("insert into storage.buckets(id,name,public) values('other-bucket','other-bucket',false)");
    await admin.query("insert into storage.objects(id,bucket_id) values ('private-object','dbchat-sqlite'),('other-object','other-bucket')");
    for (const role of ['anon', 'authenticated']) {
      const client = workers[0];
      await client.query(`set role ${role}`);
      try {
        assert.deepEqual((await client.query('select id from storage.objects')).rows, [{ id: 'other-object' }]);
        await assert.rejects(client.query("insert into storage.objects(id,bucket_id) values ('forbidden','dbchat-sqlite')"), error => error.code === '42501');
        assert.equal((await client.query("delete from storage.objects where bucket_id='dbchat-sqlite'")).rowCount, 0);
      } finally { await client.query('set role service_role'); }
    }
    return { roles: 2, visiblePrivateObjects: 0, deniedPrivateInserts: 2, deletedPrivateObjects: 0 };
  });

  await check('maintained account isolation SQL on the full migration chain', async () => {
    await admin.query('truncate auth.users cascade; truncate public.dbchat_retained_usage, public.dbchat_retention_reservations');
    await admin.query(await readFile(new URL('../../supabase/tests/account_isolation.sql', import.meta.url), 'utf8'));
    assert.equal((await admin.query('select count(*)::int as count from auth.users')).rows[0].count, 0);
    return { crossOwnerMutationDenied: true, requestDeduplicated: true, recoveryAndCascadeVerified: true, fixtureRolledBack: true };
  });

  return {
    status: 'PASS', databaseVersion: version, containerImage: 'postgres:17-alpine', migrations,
    backendSessions: backends.length, concurrentWorkerSessions: workerCount, maxConcurrentAdvisoryWaiters: maxConcurrentWaiters,
    checks, limitations: ['Local PostgreSQL with minimal Auth/Storage schema shims; does not exercise hosted Supabase Auth, PostgREST, Storage HTTP, email or production deployment.']
  };
}

let report;
try {
  report = await main();
} catch (error) {
  process.stderr.write(`FAIL ${currentCheck}: ${String(error.stack ?? error).replaceAll(password, '[REDACTED]')}\n`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) {
    process.stderr.write(`FAIL cleanup of ${container}: ${String(error.message ?? error).replaceAll(password, '[REDACTED]')}\n`);
    process.exitCode = 1;
  }
}
if (!process.exitCode) process.stdout.write(JSON.stringify({ ...report, containerRemoved: true }, null, 2) + '\n');
