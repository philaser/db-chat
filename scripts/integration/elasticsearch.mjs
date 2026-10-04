import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import https from 'node:https';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createTlsFixture } from './tlsFixture.mjs';

const name = `db-chat-elasticsearch-${process.pid}-${Date.now()}`;
const rootPassword = `root_${crypto.randomUUID()}`;
const readUser = `reader_${process.pid}`;
const readPassword = `reader_${crypto.randomUUID()}`;
const cache = join(process.cwd(), 'node_modules', '.cache', 'db-chat-integration');
mkdirSync(cache, { recursive: true });
const compilation = mkdtempSync(join(cache, 'elasticsearch-'));
const tlsFixture = createTlsFixture();
// This disposable identity must be readable by the image's unprivileged user.
chmodSync(tlsFixture.key, 0o644);
let connector;
let containerStarted = false;
let cleaned = false;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  connector?.close();
  if (containerStarted) { try { docker('rm', '-f', name); } catch {} }
  rmSync(compilation, { recursive: true, force: true });
  tlsFixture.close();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { cleanup(); process.exit(128 + (signal === 'SIGINT' ? 2 : 15)); });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function eventually(run, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try { return await run(); } catch (next) { error = next; await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw error;
}

// Admin access exists only to seed and inspect this owned fixture. Connector
// requests below use the engine's restricted account and verified HTTPS.
function adminRequest(port, path, method = 'GET', body, contentType = 'application/json') {
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: '127.0.0.1', servername: 'localhost', port, path, method,
      signal: AbortSignal.timeout(5_000), headers: {
        authorization: `Basic ${Buffer.from(`elastic:${rootPassword}`).toString('base64')}`,
        'content-type': contentType
      } }, response => {
      const chunks = [];
      response.on('error', reject);
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode >= 300) { reject(new Error(`Fixture request ${method} ${path} failed (${response.statusCode}): ${text}`)); return; }
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body !== undefined) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

try {
  await build({ entryPoints: { ElasticsearchConnector: 'src/server/connectors/ElasticsearchConnector.ts' },
    outdir: compilation, bundle: true, packages: 'external', platform: 'node', format: 'esm',
    outExtension: { '.js': '.mjs' }, target: 'node22', sourcemap: 'inline' });
  const { ElasticsearchConnector } = await import(pathToFileURL(join(compilation, 'ElasticsearchConnector.mjs')));
  const port = await reservePort();
  docker('run', '-d', '--name', name, '--memory', '2g', '-p', `127.0.0.1:${port}:9200`,
    '--mount', `type=bind,src=${tlsFixture.certificate},dst=/usr/share/elasticsearch/config/server.crt,readonly`,
    '--mount', `type=bind,src=${tlsFixture.key},dst=/usr/share/elasticsearch/config/server.key,readonly`,
    '-e', 'discovery.type=single-node', '-e', 'xpack.security.enabled=true',
    '-e', 'xpack.security.http.ssl.enabled=true', '-e', 'xpack.security.http.ssl.certificate=server.crt',
    '-e', 'xpack.security.http.ssl.key=server.key', '-e', 'xpack.security.transport.ssl.enabled=false',
    '-e', 'xpack.ml.enabled=false', '-e', 'ES_JAVA_OPTS=-Xms512m -Xmx512m',
    '-e', `ELASTIC_PASSWORD=${rootPassword}`, 'docker.elastic.co/elasticsearch/elasticsearch:8.18.0');
  containerStarted = true;
  const version = await eventually(() => adminRequest(port, '/'));
  await adminRequest(port, '/_security/role/connector_reader', 'PUT', {
    cluster: ['monitor'], indices: [{ names: ['dbchat_*'], privileges: ['read', 'view_index_metadata', 'monitor'] }]
  });
  await adminRequest(port, `/_security/user/${readUser}`, 'PUT', { password: readPassword, roles: ['connector_reader'] });
  await adminRequest(port, '/dbchat_events', 'PUT', { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: {
    seq: { type: 'integer' }, category: { type: 'keyword' }, amount: { type: 'double' },
    happenedAt: { type: 'date' }, nested: { properties: { source: { type: 'keyword' } } }
  } } });
  const events = Array.from({ length: 121 }, (_, index) => ({ seq: index + 1, category: index % 2 ? 'b' : 'a', amount: index + 1,
    happenedAt: '2026-09-01T00:00:00Z', nested: { source: 'fixture' } }));
  const bulk = async (index, rows) => {
    const result = await adminRequest(port, '/_bulk?refresh=true', 'POST', rows.flatMap((row, id) => [JSON.stringify({ index: { _index: index, _id: String(id + 1) } }), JSON.stringify(row)]).join('\n') + '\n', 'application/x-ndjson');
    assert.equal(result.errors, false);
  };
  await bulk('dbchat_events', events);
  await adminRequest(port, '/dbchat_exports', 'PUT', { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: { seq: { type: 'integer' } } } });
  await bulk('dbchat_exports', Array.from({ length: 1205 }, (_, index) => ({ seq: index + 1 })));

  const connection = { id: 'elasticsearch-live', kind: 'elasticsearch', label: 'Elasticsearch integration',
    elasticsearchHost: 'localhost', elasticsearchPort: port, elasticsearchUseSsl: true, elasticsearchVerifyCerts: true,
    elasticsearchUsername: readUser, elasticsearchPassword: readPassword, resolvedAddress: '127.0.0.1', createdAt: new Date().toISOString() };
  connector = new ElasticsearchConnector();
  await connector.connect(connection);
  const schema = await connector.introspect();
  assert.deepEqual(schema.tables.map(table => table.name).sort(), ['dbchat_events', 'dbchat_exports']);
  assert.equal(schema.tables.find(table => table.name === 'dbchat_events').columns.find(column => column.name === 'nested.source').type, 'keyword');

  connector.setResultLimit(100);
  const bounded = await connector.executeQuery(JSON.stringify({ index: 'dbchat_events', body: { query: { match_all: {} }, sort: [{ seq: 'asc' }] } }));
  assert.equal(bounded.rowCount, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.rows[0].seq, 1);
  const aggregate = await connector.executeQuery(JSON.stringify({ index: 'dbchat_events', body: { size: 0, aggs: {
    categories: { terms: { field: 'category', order: { _key: 'asc' } }, aggs: { total: { sum: { field: 'amount' } } } }
  } } }));
  assert.deepEqual(aggregate.rows, [
    { 'categories.key': 'a', 'categories.doc_count': 61, 'categories.total.value': 3721 },
    { 'categories.key': 'b', 'categories.doc_count': 60, 'categories.total.value': 3660 }
  ]);
  await assert.rejects(connector.executeQuery(JSON.stringify({ index: 'dbchat_events', body: { terminate_after: 1, aggs: { total: { sum: { field: 'amount' } } } } })), /terminated early; incomplete results were discarded/);
  await adminRequest(port, '/dbchat_bad', 'PUT', { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: { amount: { type: 'keyword' } } } });
  await bulk('dbchat_bad', [{ amount: 'not numeric' }]);
  await assert.rejects(connector.executeQuery(JSON.stringify({ index: 'dbchat_events,dbchat_bad', body: { size: 0, aggs: { total: { sum: { field: 'amount' } } } } })), /failed on 1 shard\(s\); incomplete results were discarded/);

  const exportQuery = JSON.stringify({ index: 'dbchat_exports', body: { query: { match_all: {} }, sort: [{ seq: 'asc' }] } });
  const exported = [];
  for await (const batch of connector.exportQuery(exportQuery, { batchSize: 100 })) exported.push(...batch.rows);
  assert.equal(exported.length, 1205);
  assert.equal(exported.at(-1).seq, 1205);
  const limited = [];
  for await (const batch of connector.exportQuery(JSON.stringify({ index: 'dbchat_exports', body: { size: 1005, sort: [{ seq: 'asc' }] } }))) limited.push(...batch.rows);
  assert.equal(limited.length, 1005);
  const openContexts = async () => Object.values((await adminRequest(port, '/_nodes/stats/indices/search')).nodes)
    .reduce((sum, node) => sum + node.indices.search.open_contexts, 0);
  assert.equal(await openContexts(), 0);
  const cancellation = new AbortController();
  const cursor = connector.exportQuery(exportQuery, { signal: cancellation.signal, batchSize: 10 })[Symbol.asyncIterator]();
  assert.equal((await cursor.next()).value.rowCount, 10);
  assert.equal(await openContexts(), 1);
  cancellation.abort(new DOMException('Integration cancellation', 'AbortError'));
  await assert.rejects(cursor.next(), error => error?.name === 'AbortError');
  assert.equal(await openContexts(), 0);

  await adminRequest(port, '/dbchat_large', 'PUT', { settings: { number_of_shards: 1, number_of_replicas: 0 }, mappings: { properties: { payload: { type: 'text', index: false } } } });
  await bulk('dbchat_large', [{ payload: 'x'.repeat(9 * 1024 * 1024) }]);
  const largeQuery = JSON.stringify({ index: 'dbchat_large', body: { query: { match_all: {} } } });
  await assert.rejects(connector.executeQuery(largeQuery), /size limit/);
  await assert.rejects(async () => { for await (const _batch of connector.exportQuery(largeQuery)) {} }, /size limit/);
  connector.close();
  await connector.connect(connection);
  assert.equal((await connector.executeQuery(JSON.stringify({ index: 'dbchat_events', body: { size: 0 } }))).rows[0].total_hits, 121);

  const write = JSON.stringify({ index: 'dbchat_events', operation: 'index', id: 'forbidden', body: { seq: -1 } });
  await assert.rejects(connector.executeQuery(write), /request failed \(403\)/);
  connector.setSafetyLevel('safe');
  await assert.rejects(connector.executeQuery(write), /blocked in safe mode/);
  await assert.rejects(async () => { for await (const _batch of connector.exportQuery(write)) {} }, /read-only/);
  const bad = new ElasticsearchConnector();
  try { await assert.rejects(bad.connect({ ...connection, elasticsearchPassword: 'incorrect' }), /request failed \(401\)/); } finally { bad.close(); }
  const wrongHost = new ElasticsearchConnector();
  try { await assert.rejects(wrongHost.connect({ ...connection, elasticsearchHost: 'wrong-host.invalid' }), /certificate|hostname|altnames/i); } finally { wrongHost.close(); }
  const cancelled = new AbortController();
  cancelled.abort(new DOMException('Integration cancellation', 'AbortError'));
  await assert.rejects(connector.executeQuery(exportQuery, { signal: cancelled.signal }), error => error?.name === 'AbortError');

  console.log(JSON.stringify({ passed: true, serverVersion: version.version.number, verifiedTls: 'passed', tlsHostnameDenial: 'passed',
    schemaAndAggregations: 'passed', sourceDocuments: 121, returnedRows: bounded.rowCount, truncated: bounded.truncated,
    earlyTerminationRejected: 'passed', partialShardAggregationRejected: 'passed', fullStreamingExport: exported.length,
    explicitExportLimit: limited.length, activeExportCancellationAndScrollCleanup: 'passed', oversizedQueryAndExport: '9 MiB rejected',
    oversizedResponseReconnect: 'passed', authFailure: 'passed', readRoleWriteDenial: 'passed', safeWriteDenial: 'passed' }, null, 2));
} catch (error) {
  try { console.error(`Elasticsearch container state: ${docker('inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}', name)}\n${docker('logs', '--tail', '30', name)}`); } catch {}
  throw error;
} finally {
  cleanup();
}
