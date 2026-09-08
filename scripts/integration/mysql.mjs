#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import mysql from 'mysql2/promise';

const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const serverRoot = path.resolve(arg('--server-root') ?? 'dist-web-server');
const image = arg('--image') ?? 'mysql:8.4';
const container = `dbchat-mysql-it-${process.pid}-${Date.now()}`;
const rootPassword = `local-root-${process.pid}`;
const database = 'dbchat_it';
const reader = 'dbchat_reader';
const readerPassword = `local-reader-${process.pid}`;
const results = [];
let root;
let cleaned = false;

function docker(...args) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { docker('rm', '-f', container); } catch { /* container may not have been created */ }
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { cleanup(); process.exit(code); });
}

async function check(name, run) {
  const started = performance.now();
  await run();
  results.push({ name, elapsedMs: Math.round(performance.now() - started) });
}

async function waitForMySQL(port) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const connection = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: rootPassword, database, multipleStatements: true });
      return connection;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(`MySQL did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

try {
  docker('run', '-d', '--name', container, '-e', `MYSQL_ROOT_PASSWORD=${rootPassword}`, '-e', `MYSQL_DATABASE=${database}`, '-p', '127.0.0.1::3306', image);
  const portOutput = docker('port', container, '3306/tcp');
  const port = Number(portOutput.match(/:(\d+)$/)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, `Could not parse mapped MySQL port from ${portOutput}`);
  root = await waitForMySQL(port);

  await root.query(`
    CREATE TABLE customers (
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      display_name VARCHAR(80) NOT NULL,
      PRIMARY KEY (tenant_id, customer_id)
    );
    CREATE TABLE \`Order Details\` (
      order_id INT PRIMARY KEY,
      tenant_id INT NOT NULL,
      customer_id INT NOT NULL,
      \`unit-price\` DECIMAL(12,2) NOT NULL,
      tax DECIMAL(12,2) NULL,
      ordered_on DATE NOT NULL,
      created_at DATETIME(3) NOT NULL,
      CONSTRAINT fk_order_customer FOREIGN KEY (tenant_id, customer_id)
        REFERENCES customers (tenant_id, customer_id)
    );
    CREATE TABLE order_tags (order_id INT NOT NULL, tag VARCHAR(30) NOT NULL);
  `);
  await root.query(`INSERT INTO customers VALUES (1, 10, 'Ada'), (1, 20, 'Ben'), (1, 30, 'Cara')`);
  await root.query(`INSERT INTO \`Order Details\` VALUES
    (1, 1, 10, 100.10, NULL, '2026-01-02', '2026-01-02 03:04:05.678'),
    (2, 1, 10, 179.90, 5.25, '2026-01-03', '2026-01-03 04:05:06.789'),
    (3, 1, 20, 240.00, 0.00, '2026-02-04', '2026-02-04 05:06:07.890'),
    (4, 1, 30, 90.00, NULL, '2026-03-05', '2026-03-05 06:07:08.901')`);
  await root.query(`INSERT INTO order_tags VALUES (1, 'new'), (1, 'priority'), (2, 'new'), (3, 'new')`);
  await root.query(`CREATE TABLE sequence_rows (id INT PRIMARY KEY)`);
  await root.query(`SET SESSION cte_max_recursion_depth = 2000`);
  await root.query(`INSERT INTO sequence_rows (id)
    WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 1205)
    SELECT n FROM seq`);
  await root.query(`CREATE USER 'dbchat_reader'@'%' IDENTIFIED BY ?`, [readerPassword]);
  await root.query(`GRANT SELECT ON \`${database}\`.* TO 'dbchat_reader'@'%'`);

  const connectorUrl = pathToFileURL(path.join(serverRoot, 'server/connectors/MySQLConnector.js')).href;
  const serviceUrl = pathToFileURL(path.join(serverRoot, 'server/webAgentService.js')).href;
  const configUrl = pathToFileURL(path.join(serverRoot, 'server/config.js')).href;
  const { MySQLConnector } = await import(connectorUrl);
  const { WebAgentService } = await import(serviceUrl);
  const { loadWebServerConfig } = await import(configUrl);
  const config = { id: 'mysql-it', kind: 'mysql', label: 'MySQL integration', host: 'localhost', resolvedAddress: '127.0.0.1', port, database, username: reader, password: readerPassword, createdAt: new Date().toISOString() };
  const connector = new MySQLConnector();

  await check('connect with SELECT-only account', async () => connector.connect(config));
  await check('schema, odd identifiers, PKs, and composite FK', async () => {
    const schema = await connector.introspect();
    const orders = schema.tables.find((table) => table.name === 'Order Details');
    assert.equal(orders?.qualifiedName, '`dbchat_it`.`Order Details`');
    assert.equal(orders?.columns.find((column) => column.name === 'order_id')?.primaryKey, true);
    assert.deepEqual(orders?.relationships, [{ columns: ['tenant_id', 'customer_id'], referencedSchema: database, referencedTable: 'customers', referencedColumns: ['tenant_id', 'customer_id'] }]);
    assert.deepEqual(orders?.columns.find((column) => column.name === 'customer_id')?.foreignKey, { schema: database, table: 'customers', column: 'customer_id' });
    assert.match(await connector.getContextForPrompt(), /`dbchat_it`\.`Order Details`/);
  });
  await check('decimal, NULL, DATE, and DATETIME values', async () => {
    const result = await connector.executeQuery('SELECT `unit-price` AS price, tax, ordered_on, created_at FROM `Order Details` WHERE order_id = 1');
    assert.equal(result.rows[0].price, '100.10');
    assert.equal(result.rows[0].tax, null);
    assert.ok(result.rows[0].ordered_on instanceof Date);
    assert.ok(result.rows[0].created_at instanceof Date);
  });
  await check('join fanout can be reconciled to correct totals', async () => {
    const result = await connector.executeQuery(`WITH order_totals AS (
      SELECT tenant_id, customer_id, SUM(\`unit-price\`) AS total
      FROM \`Order Details\` GROUP BY tenant_id, customer_id
    ) SELECT c.display_name, COALESCE(o.total, 0) AS total
      FROM customers c LEFT JOIN order_totals o USING (tenant_id, customer_id)
      ORDER BY c.customer_id`);
    assert.deepEqual(result.rows.map((row) => [row.display_name, row.total]), [['Ada', '280.00'], ['Ben', '240.00'], ['Cara', '90.00']]);
  });
  await check('101+ row result is explicitly truncated', async () => {
    connector.setResultLimit(100);
    const result = await connector.executeQuery('SELECT id FROM sequence_rows ORDER BY id');
    assert.equal(result.rowCount, 100);
    assert.equal(result.truncated, true);
    assert.equal(result.rowLimit, 100);
    assert.equal(result.rows.at(-1).id, 100);
  });
  await check('streaming export returns every row and preserves explicit LIMIT', async () => {
    const exported = [];
    for await (const batch of connector.exportQuery('SELECT id FROM sequence_rows ORDER BY id')) exported.push(...batch.rows);
    assert.equal(exported.length, 1205);
    assert.equal(exported.at(-1).id, 1205);
    const limited = [];
    for await (const batch of connector.exportQuery('SELECT id FROM sequence_rows ORDER BY id LIMIT 1005')) limited.push(...batch.rows);
    assert.equal(limited.length, 1005);
    await assert.rejects(async () => { for await (const _batch of connector.exportQuery('DELETE FROM sequence_rows')) {} }, /read-only/);
  });
  await check('safe mode and database grants both enforce read-only access', async () => {
    connector.setSafetyLevel('safe');
    await assert.rejects(connector.executeQuery(`UPDATE customers SET display_name = 'X'`), /Write queries are not permitted/);
    connector.setSafetyLevel('unrestricted');
    await assert.rejects(connector.executeQuery(`UPDATE customers SET display_name = 'X'`), /denied|command denied/i);
    connector.setSafetyLevel('safe');
  });
  await check('bad authentication is rejected', async () => {
    const invalid = new MySQLConnector();
    await assert.rejects(invalid.connect({ ...config, id: 'bad-auth', password: 'wrong-password' }), /Access denied/i);
    invalid.close();
  });
  await check('abort stops a live query and reconnect restores use', async () => {
    const controller = new AbortController();
    const pending = connector.executeQuery('SELECT SLEEP(5) AS slept', { signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('Integration cancellation.', 'AbortError')), 100);
    await assert.rejects(pending, (error) => error?.name === 'AbortError');
    await connector.connect(config);
    const result = await connector.executeQuery('SELECT COUNT(*) AS count FROM customers');
    assert.equal(result.rows[0].count, 3);
  });
  await check('WebAgentService and WebPolicyConnector produce an owned artifact', async () => {
    let round = 0;
    const service = new WebAgentService({ ...loadWebServerConfig({ DBCHAT_WEB_AUTH_MODE: 'app' }), database: config, maxResultRows: 100 }, {
      modelClient: { async *streamChat() {
        if (round++ === 0) {
          yield { toolCalls: [{ index: 0, id: 'mysql-query', function: { name: 'run_database_query', arguments: JSON.stringify({
            query: 'SELECT display_name, SUM(`unit-price`) AS total FROM customers JOIN `Order Details` USING (tenant_id, customer_id) GROUP BY display_name ORDER BY display_name',
            purpose: 'Verify customer totals through the hosted web policy'
          }) } }] };
          return;
        }
        yield { content: 'The customer totals were calculated from the owned MySQL result.' };
      } }
    });
    await service.initialize();
    assert.equal(service.getBootstrap().ready, true);
    const turn = await service.run([{ role: 'user', content: 'Calculate total order value by customer.' }], 'mysql-web-turn', () => undefined);
    assert.equal(turn.artifacts.length, 1);
    assert.equal(turn.artifacts[0].queryId, 'mysql-web-turn-query-1');
    assert.deepEqual(turn.artifacts[0].result.rows.map((row) => [row.display_name, row.total]), [['Ada', '280.00'], ['Ben', '240.00'], ['Cara', '90.00']]);
    assert.equal(turn.artifacts[0].schema?.kind, 'mysql');
    assert.match(turn.message.content, /owned MySQL result/);
    service.close();
  });

  connector.close();
  const [versionRows] = await root.query('SELECT VERSION() AS version');
  console.log(JSON.stringify({ image, mysqlVersion: versionRows[0].version, port, checks: results.length, results }, null, 2));
} finally {
  await root?.end().catch(() => undefined);
  cleanup();
}
