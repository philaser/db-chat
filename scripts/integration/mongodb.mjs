import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { MongoClient } from 'mongodb';

const name = `db-chat-mongodb-${process.pid}-${Date.now()}`;
const rootUser = `root_${process.pid}`;
const rootPassword = `root_${crypto.randomUUID()}`;
const readUser = `reader_${process.pid}`;
const readPassword = `reader_${crypto.randomUUID()}`;
const database = 'connector_integration';
const cache = join(process.cwd(), 'node_modules', '.cache', 'db-chat-integration');
mkdirSync(cache, { recursive: true });
const compilation = mkdtempSync(join(cache, 'mongodb-'));
let connector;
let service;
let containerStarted = false;
let cleaned = false;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  service?.close();
  connector?.close();
  if (containerStarted) {
    try { docker('rm', '-f', name); } catch {}
  }
  rmSync(compilation, { recursive: true, force: true });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  });
}

async function eventually(run, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try { return await run(); } catch (next) { error = next; await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  throw error;
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

try {
  await build({
    entryPoints: {
      MongoDBConnector: 'src/server/connectors/MongoDBConnector.ts',
      WebAgentService: 'src/server/webAgentService.ts',
      config: 'src/server/config.ts'
    },
    outdir: compilation,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    outExtension: { '.js': '.mjs' },
    target: 'node22',
    sourcemap: 'inline'
  });
  const { MongoDBConnector } = await import(pathToFileURL(join(compilation, 'MongoDBConnector.mjs')));
  const { WebAgentService } = await import(pathToFileURL(join(compilation, 'WebAgentService.mjs')));
  const { loadWebServerConfig } = await import(pathToFileURL(join(compilation, 'config.mjs')));

  const port = await reservePort();
  docker('run', '-d', '--name', name, '-p', `127.0.0.1:${port}:27017`,
    '-e', 'GLIBC_TUNABLES=glibc.pthread.rseq=1',
    '-e', `MONGO_INITDB_ROOT_USERNAME=${rootUser}`,
    '-e', `MONGO_INITDB_ROOT_PASSWORD=${rootPassword}`, 'mongo:8');
  containerStarted = true;
  const rootUri = `mongodb://${encodeURIComponent(rootUser)}:${encodeURIComponent(rootPassword)}@127.0.0.1:${port}/?authSource=admin&directConnection=true`;
  const admin = await eventually(async () => {
    const client = new MongoClient(rootUri, { serverSelectionTimeoutMS: 1_000 });
    try { await client.connect(); return client; } catch (error) { await client.close(); throw error; }
  });
  const db = admin.db(database);
  await db.collection('events').insertMany([
    { seq: 1, category: 'a', amount: 10, happenedAt: new Date('2026-09-01T00:00:00Z'), optional: null },
    { seq: 2, category: 'a', amount: 15.5, happenedAt: new Date('2026-09-02T00:00:00Z'), sparse: true },
    { seq: 3, category: 'b', amount: 'unknown', nested: { source: 'fixture' } },
    ...Array.from({ length: 118 }, (_, index) => ({ seq: index + 4, category: index % 2 ? 'a' : 'b', amount: index }))
  ]);
  await db.createCollection('empty_collection');
  await db.command({ createUser: readUser, pwd: readPassword, roles: [{ role: 'read', db: database }] });
  await admin.close();

  const readUri = `mongodb://${encodeURIComponent(readUser)}:${encodeURIComponent(readPassword)}@127.0.0.1:${port}/${database}?authSource=${database}&directConnection=true`;
  connector = new MongoDBConnector();
  await connector.connect({ id: 'mongo-live', kind: 'mongodb', label: 'Mongo integration', database, mongodbUri: readUri, mongodbDirectConnection: true, createdAt: new Date().toISOString() });

  const schema = await connector.introspect();
  assert.equal(schema.inference.partial, true);
  assert.equal(schema.inference.maxDocuments, 40);
  assert.equal(schema.inference.sampledDocuments, 20);
  assert.deepEqual(schema.tables.map(table => table.name).sort(), ['empty_collection', 'events']);
  const events = schema.tables.find(table => table.name === 'events');
  assert.equal(events.inference.sampledDocuments, 20);
  assert.equal(events.columns.find(column => column.name === 'optional').nullable, true);
  assert.match(events.columns.find(column => column.name === 'amount').type, /number/);
  assert.equal(schema.tables.find(table => table.name === 'empty_collection').columns.length, 0);

  const aggregate = await connector.executeQuery(JSON.stringify({ collection: 'events', method: 'aggregate', body: { pipeline: [
    { $match: { seq: { $lte: 3 } } },
    { $group: { _id: '$category', total: { $sum: { $cond: [{ $isNumber: '$amount' }, '$amount', 0] } }, nullCount: { $sum: { $cond: [{ $eq: [{ $ifNull: ['$optional', null] }, null] }, 1, 0] } }, firstDate: { $min: '$happenedAt' } } },
    { $sort: { _id: 1 } }
  ] } }));
  assert.equal(aggregate.rowCount, 2);
  assert.deepEqual(aggregate.rows[0], { _id: 'a', total: 25.5, nullCount: 2, firstDate: new Date('2026-09-01T00:00:00Z') });

  connector.setResultLimit(100);
  const bounded = await connector.executeQuery(JSON.stringify({ collection: 'events', method: 'find', body: { filter: {}, limit: 500, options: { sort: { seq: 1 } } } }));
  assert.equal(bounded.rowCount, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.rowLimit, 100);

  let modelRound = 0;
  const serviceConnector = new MongoDBConnector();
  service = new WebAgentService({ ...loadWebServerConfig({ DBCHAT_STORAGE_MODE: 'local' }), database: {
    id: 'mongo-service', kind: 'mongodb', label: 'Mongo integration', database,
    mongodbUri: readUri, mongodbDirectConnection: true, createdAt: new Date().toISOString()
  }, maxResultRows: 100 }, {
    connector: serviceConnector,
    modelClient: { async *streamChat() {
      if (modelRound++ === 0) {
        yield { toolCalls: [{ index: 0, id: 'mongo-count', function: { name: 'run_database_query', arguments: JSON.stringify({
          query: JSON.stringify({ collection: 'events', method: 'aggregate', body: { pipeline: [{ $group: { _id: '$category', total: { $sum: 1 } } }, { $sort: { _id: 1 } }] } }),
          purpose: 'Count events by category'
        }) } }] };
        return;
      }
      yield { content: 'The verified category totals are available in the attached result.' };
    } }
  });
  await service.initialize();
  assert.equal(service.getBootstrap().ready, true);
  assert.equal(service.getBootstrap().database.readOnly, true);
  const turn = await service.run([{ role: 'user', content: 'Count events by category.' }], 'mongo-live-turn', () => undefined);
  assert.equal(turn.artifacts.length, 1);
  assert.deepEqual(turn.artifacts[0].result.rows, [{ _id: 'a', total: 61 }, { _id: 'b', total: 60 }]);
  assert.match(turn.message.content, /verified category totals/);
  service.close();
  service = undefined;

  await assert.rejects(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'insertOne', document: { forbidden: true } })), /not authorized|unauthorized/i);
  await assert.rejects(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'aggregate', body: { pipeline: [{ $out: 'copied' }] } })), /blocked/i);
  await assert.rejects(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'aggregate', body: { pipeline: [{ $merge: 'copied' }] } })), /blocked/i);

  const cancelled = new AbortController();
  cancelled.abort(new DOMException('Integration cancellation', 'AbortError'));
  await assert.rejects(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'count', body: { filter: {} } }), { signal: cancelled.signal }), error => error?.name === 'AbortError');

  const bad = new MongoDBConnector();
  await assert.rejects(bad.connect({ id: 'bad', kind: 'mongodb', label: 'Bad auth', database, mongodbUri: readUri.replace(encodeURIComponent(readPassword), 'incorrect'), mongodbDirectConnection: true, createdAt: new Date().toISOString() }), /authentication failed/i);

  docker('stop', '-t', '1', name);
  await assert.rejects(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'count', body: { filter: {} } })));
  docker('start', name);
  await eventually(async () => assert.equal((await connector.executeQuery(JSON.stringify({ collection: 'events', method: 'count', body: { filter: {} } }))).rows[0].count, 121), 30_000);

  const versionClient = new MongoClient(rootUri, { serverSelectionTimeoutMS: 2_000 });
  await versionClient.connect();
  const buildInfo = await versionClient.db('admin').command({ buildInfo: 1 });
  await versionClient.close();
  console.log(JSON.stringify({
    passed: true,
    serverVersion: buildInfo.version,
    collections: schema.tables.length,
    schemaSampleDocuments: schema.inference.sampledDocuments,
    schemaSampleMaximum: schema.inference.maxDocuments,
    sourceDocuments: 121,
    returnedRows: bounded.rowCount,
    rowLimit: bounded.rowLimit,
    truncated: bounded.truncated,
    reconnect: 'passed',
    cancellation: 'passed',
    authFailure: 'passed',
    readRoleWriteDenial: 'passed',
    webAgentServiceTurn: 'passed'
  }, null, 2));
} catch (error) {
  try {
    const state = docker('inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}', name);
    const logs = docker('logs', '--tail', '40', name);
    console.error(`MongoDB container state: ${state}\n${logs}`);
  } catch {}
  throw error;
} finally {
  cleanup();
}
