import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const runId = `${process.pid}-${Date.now()}`;
const container = `db-chat-postgres-integration-${runId}`;
const adminPassword = randomBytes(18).toString('base64url');
const readerPassword = randomBytes(18).toString('base64url');
const buildDir = path.resolve('node_modules/.cache', `db-chat-postgres-integration-${runId}`);
let containerStarted = false;
let cleaningUp = false;
let activeConnector;

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
}

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  activeConnector?.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  if (containerStarted) {
    try { docker(['rm', '-f', container]); } catch { /* best effort after a failed run */ }
  }
  await rm(buildDir, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void cleanup().finally(() => process.exit(128 + (signal === 'SIGINT' ? 2 : 15))); });
}

function psql(sql, user = 'postgres') {
  return docker(
    ['exec', '-i', '-e', `PGPASSWORD=${user === 'postgres' ? adminPassword : readerPassword}`, container,
      'psql', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-tA', '-U', user, '-d', 'integration'],
    { input: sql }
  );
}

function connection(port, password = readerPassword) {
  return {
    id: 'postgres-integration', kind: 'postgres', label: 'PostgreSQL integration fixture',
    host: '127.0.0.1', port, database: 'integration', username: 'dbchat_reader', password,
    ssl: false, createdAt: new Date().toISOString()
  };
}

async function main() {
  await mkdir(buildDir, { recursive: true });
  await build({
    stdin: {
      contents: `export { PostgresConnector } from ${JSON.stringify(path.resolve('src/server/connectors/PostgresConnector.ts'))};\nexport { WebAgentService } from ${JSON.stringify(path.resolve('src/server/webAgentService.ts'))};\nexport { loadWebServerConfig } from ${JSON.stringify(path.resolve('src/server/config.ts'))};`,
      resolveDir: process.cwd(), loader: 'ts'
    },
    outfile: path.join(buildDir, 'PostgresConnector.mjs'), bundle: true, platform: 'node', format: 'esm',
    packages: 'external', sourcemap: 'inline'
  });
  const { PostgresConnector, WebAgentService, loadWebServerConfig } = await import(`${pathToFileURL(path.join(buildDir, 'PostgresConnector.mjs')).href}?run=${runId}`);

  docker(['run', '--detach', '--rm', '--name', container, '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${adminPassword}`, '--env', 'POSTGRES_DB=integration', 'postgres:17-alpine']);
  containerStarted = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'integration']); break; }
    catch (error) {
      if (attempt === 59) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  // The official image briefly starts a bootstrap server during first-time
  // initialization. Wait past that handoff and require the final server too.
  await new Promise(resolve => setTimeout(resolve, 1000));
  docker(['exec', container, 'pg_isready', '-U', 'postgres', '-d', 'integration']);
  const portText = docker(['port', container, '5432/tcp']);
  const port = Number(portText.match(/:(\d+)$/)?.[1]);
  assert(Number.isInteger(port) && port > 0, `Could not parse PostgreSQL port from ${portText}`);

  psql(`
    create role dbchat_reader login password '${readerPassword}';
    create schema crm;
    create schema sales;
    create schema "odd.schema";
    create schema private_data;
    create table crm."Customers" (
      tenant_id integer not null,
      id integer not null,
      display_name text not null,
      primary key (tenant_id, id)
    );
    create table sales."Orders" (
      tenant_id integer not null,
      customer_id integer not null,
      order_id integer not null,
      amount numeric(20, 4),
      booked_at timestamptz not null,
      note text,
      primary key (tenant_id, order_id),
      constraint orders_customer_fk foreign key (tenant_id, customer_id)
        references crm."Customers" (tenant_id, id)
    );
    create table "odd.schema"."Table""Name" ("select" integer primary key, "mixed Case" text);
    create table private_data.secrets (id integer primary key, value text not null);
    create sequence sales.probe_seq;
    create table sales.export_rows (id integer primary key);
    insert into crm."Customers" values (1, 1, 'Ada'), (1, 2, 'Grace');
    insert into sales."Orders" (tenant_id, customer_id, order_id, amount, booked_at, note)
      select 1, case when n % 2 = 0 then 1 else 2 end, n,
             case when n = 3 then null else n::numeric / 10000 end,
             case when n = 1 then '1900-01-01 00:00:00+00'::timestamptz
                  when n = 150 then '2099-12-31 23:59:59.999999+00'::timestamptz
                  else '2026-01-01 00:00:00+00'::timestamptz + n * interval '1 day' end,
             case when n = 3 then null else 'fixture' end
      from generate_series(1, 150) n;
    insert into "odd.schema"."Table""Name" values (1, 'quoted identifier works');
    insert into private_data.secrets values (1, 'must not be visible');
    insert into sales.export_rows select n from generate_series(1, 1205) n;
    grant connect on database integration to dbchat_reader;
    grant usage on schema crm, sales, "odd.schema" to dbchat_reader;
    grant select on crm."Customers", sales."Orders", sales.export_rows, "odd.schema"."Table""Name" to dbchat_reader;
    grant usage on sequence sales.probe_seq to dbchat_reader;
  `);

  const connector = new PostgresConnector();
  activeConnector = connector;
  await connector.connect(connection(port));
  const version = await connector.executeQuery('select version() as version');
  const versionText = String(version.rows[0].version);
  assert.match(versionText, /^PostgreSQL 17\./);

  connector.setSafetyLevel('safe');
  const cancellation = new AbortController();
  const cancellationStarted = performance.now();
  const sleeping = connector.executeQuery('select pg_sleep(5)', { signal: cancellation.signal });
  setTimeout(() => cancellation.abort(), 100);
  await assert.rejects(sleeping, error => error?.name === 'AbortError');
  const cancellationMs = Math.round(performance.now() - cancellationStarted);
  assert(cancellationMs < 2_000, `Cancellation took ${cancellationMs}ms`);
  await assert.rejects(() => connector.executeQuery('select 1'), /No database is connected/);
  await connector.connect(connection(port));
  assert.equal((await connector.executeQuery('select 1::int as recovered')).rows[0].recovered, 1);

  connector.setSafetyLevel('standard');
  await connector.executeQuery("select set_config('statement_timeout', '150', false)");
  const timeoutStarted = performance.now();
  await assert.rejects(() => connector.executeQuery('select pg_sleep(5)'), /statement timeout/i);
  const statementTimeoutMs = Math.round(performance.now() - timeoutStarted);
  assert(statementTimeoutMs >= 50 && statementTimeoutMs < 2_000, `Statement timeout took ${statementTimeoutMs}ms`);
  assert.equal((await connector.executeQuery('select 1::int as connected')).rows[0].connected, 1);
  await connector.executeQuery("select set_config('statement_timeout', '30000', false)");

  const schema = await connector.introspect();
  assert.deepEqual(schema.tables.map(table => table.qualifiedName), [
    '"crm"."Customers"', '"odd.schema"."Table""Name"', '"sales"."Orders"', '"sales"."export_rows"'
  ]);
  assert(!schema.tables.some(table => table.schema === 'private_data'));
  const orders = schema.tables.find(table => table.qualifiedName === '"sales"."Orders"');
  assert(orders);
  assert.deepEqual(orders.columns.filter(column => column.primaryKey).map(column => column.name), ['tenant_id', 'order_id']);
  assert.deepEqual(orders.relationships, [{
    columns: ['tenant_id', 'customer_id'], referencedSchema: 'crm', referencedTable: 'Customers',
    referencedColumns: ['tenant_id', 'id']
  }]);

  const quoted = await connector.executeQuery('select "mixed Case" from "odd.schema"."Table""Name" where "select" = 1');
  assert.deepEqual(quoted.rows, [{ 'mixed Case': 'quoted identifier works' }]);

  const totals = await connector.executeQuery(`
    select c.display_name, count(*)::int as order_count, sum(o.amount) as total
    from sales."Orders" o
    join crm."Customers" c on (c.tenant_id, c.id) = (o.tenant_id, o.customer_id)
    group by c.display_name order by c.display_name
  `);
  assert.deepEqual(totals.rows, [
    { display_name: 'Ada', order_count: 75, total: '0.5700' },
    { display_name: 'Grace', order_count: 75, total: '0.5622' }
  ]);

  const boundaries = await connector.executeQuery(`
    select order_id, amount, booked_at, note from sales."Orders" where order_id in (1, 3, 150) order by order_id
  `);
  assert.equal(boundaries.rows[0].amount, '0.0001');
  assert.equal(boundaries.rows[1].amount, null);
  assert.equal(boundaries.rows[1].note, null);
  assert.equal(boundaries.rows[0].booked_at.toISOString(), '1900-01-01T00:00:00.000Z');
  assert.equal(boundaries.rows[2].booked_at.toISOString(), '2099-12-31T23:59:59.999Z');

  connector.setResultLimit(100);
  const bounded = await connector.executeQuery('select order_id from sales."Orders" order by order_id');
  assert.equal(bounded.rows.length, 100);
  assert.equal(bounded.rowCount, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.rowLimit, 100);

  const exported = [];
  for await (const batch of connector.exportQuery('select id from sales.export_rows order by id')) exported.push(...batch.rows);
  assert.equal(exported.length, 1205);
  assert.equal(exported.at(-1).id, 1205);
  const limitedExport = [];
  for await (const batch of connector.exportQuery('select id from sales.export_rows order by id limit 1005; -- explicit')) limitedExport.push(...batch.rows);
  assert.equal(limitedExport.length, 1005);
  await assert.rejects(async () => { for await (const _batch of connector.exportQuery('delete from sales.export_rows')) {} }, /read-only/);

  connector.setSafetyLevel('safe');
  await assert.rejects(() => connector.executeQuery('insert into sales."Orders" values (1, 1, 151, 1, now(), null)'), /Write queries are not permitted/);
  await assert.rejects(() => connector.executeQuery("select nextval('sales.probe_seq')"), /read-only transaction|cannot execute nextval/i);

  connector.setSafetyLevel('standard');
  await assert.rejects(() => connector.executeQuery("insert into \"odd.schema\".\"Table\"\"Name\" values (2, 'denied')"), /permission denied/i);
  const unchanged = await connector.executeQuery('select count(*)::int as count from "odd.schema"."Table""Name"');
  assert.equal(unchanged.rows[0].count, 1);

  connector.close();
  await assert.rejects(() => connector.executeQuery('select 1'), /No database is connected/);
  await assert.rejects(() => connector.connect(connection(port, 'wrong-password')), /password authentication failed/i);
  await connector.connect(connection(port));
  assert.equal((await connector.executeQuery('select 1::int as connected')).rows[0].connected, 1);
  const backendPid = Number((await connector.executeQuery('select pg_backend_pid()::int as pid')).rows[0].pid);
  assert.equal(psql(`select pg_terminate_backend(${backendPid});`), 't');
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(() => connector.executeQuery('select 1'), /No database is connected/);
  await connector.connect(connection(port));
  assert.equal((await connector.executeQuery('select 1::int as recovered')).rows[0].recovered, 1);
  connector.close();
  activeConnector = undefined;

  let modelRound = 0;
  const config = {
    ...loadWebServerConfig({ DBCHAT_STORAGE_MODE: 'local', DBCHAT_WEB_AUTH_MODE: 'dev' }),
    database: connection(port), maxResultRows: 100, maxResultBytes: 1024 * 1024
  };
  const service = new WebAgentService(config, {
    connector: new PostgresConnector(),
    modelClient: { async *streamChat() {
      if (modelRound++ === 0) {
        yield { toolCalls: [{ index: 0, id: 'postgres-total', function: {
          name: 'run_database_query', arguments: JSON.stringify({
            query: `select c.display_name, count(*)::int as order_count, sum(o.amount) as total
              from sales."Orders" o join crm."Customers" c
                on (c.tenant_id, c.id) = (o.tenant_id, o.customer_id)
              group by c.display_name order by c.display_name`,
            purpose: 'Calculate order counts and totals by customer',
            assumptions: ['Each order belongs to one customer through the composite tenant and customer key.'],
            verification: [{ check: 'join-cardinality', status: 'checked', detail: 'The composite foreign key makes each order match one customer.' }]
          })
        } }] };
        return;
      }
      yield { content: 'Ada has 75 orders totaling 0.5700; Grace has 75 orders totaling 0.5622.' };
    } }
  });
  activeConnector = service;
  await service.initialize();
  assert.equal(service.getBootstrap().ready, true);
  const agentResult = await service.run(
    [{ role: 'user', content: 'Give me order counts and totals by customer.' }],
    'postgres-live-turn', () => {}
  );
  assert.equal(agentResult.artifacts.length, 1);
  assert.deepEqual(agentResult.artifacts[0].result.rows, totals.rows);
  assert.match(agentResult.message.content, /Ada has 75 orders totaling 0\.5700/);
  service.close();
  activeConnector = undefined;

  process.stdout.write(JSON.stringify({
    databaseVersion: versionText, containerImage: 'postgres:17-alpine', exposedPort: port,
    visibleTables: schema.tables.length, hiddenTables: 1, fixtureOrders: 150,
    truncatedRowsReturned: bounded.rowCount,
    cancellationMs, statementTimeoutMs,
    checks: ['quoted and schema-qualified identifiers', 'composite primary and foreign keys', 'restricted introspection',
      'decimal, null, and timestamp boundaries', 'join totals', 'result truncation', 'full streaming export and explicit limit', 'safe-mode and database read-only enforcement',
      'invalid authentication', 'signal cancellation and reconnect', 'server statement timeout and connection reuse',
      'unexpected disconnect and reconnect', 'scripted WebAgentService turn through WebPolicyConnector'],
    agentArtifactRows: agentResult.artifacts[0].result.rowCount,
    limitations: ['A deterministic connection-establishment timeout test is omitted because the connector timeout is 10 seconds and unroutable addresses are environment-dependent.']
  }, null, 2) + '\n');
}

try {
  await main();
} finally {
  await cleanup();
}
