import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteConnector } from '../src/server/connectors/SQLiteConnector';
import { QueryValidator, classifyQuery } from '../src/server/connectors/QueryValidator';
import { PermissionManager } from '../src/server/agent/PermissionManager';
import { WebPolicyConnector } from '../src/server/connectorFactory';
import { MongoDBConnector } from '../src/server/connectors/MongoDBConnector';
import { ElasticsearchConnector } from '../src/server/connectors/ElasticsearchConnector';
import { sampleDataTool } from '../src/server/agent/tools/SampleDataTool';
import type { DatabaseConnector, DatabaseSchema } from '../src/shared/types';
import type { ToolContext } from '../src/server/agent/types';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllGlobals(); });

async function fixture(timeoutMs = 30_000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dbchat-policy-'));
  dirs.push(dir);
  const databasePath = path.join(dir, 'fixture.db');
  const db = new Database(databasePath);
  db.exec("CREATE TABLE items(id INTEGER, name TEXT); INSERT INTO items VALUES(1,'one'),(2,'two'),(3,'three');");
  db.close();
  const connector = new SQLiteConnector(timeoutMs);
  await connector.connect({ id: 'fixture', kind: 'sqlite', label: 'fixture', databasePath, createdAt: '' });
  return connector;
}

describe('database safety policy', () => {
  it.each([
    '/* audit */ DELETE FROM items RETURNING id --',
    'WITH removed AS (DELETE FROM items RETURNING *) SELECT * FROM removed',
    'SELECT * FROM items; DELETE FROM items',
    'PRAGMA writable_schema = 1',
    'SELECT * INTO OUTFILE \'/tmp/output\' FROM items',
    '/*! DELETE FROM items */ SELECT 1',
    '/* nested /* */ DELETE FROM items */ SELECT 1',
    'SELECT 1; /* comment */ SELECT 2',
    'CALL dangerous()',
    'SELECT $$dollar syntax$$'
  ])('denies unsupported or mutating Safe input: %s', query => {
    expect(QueryValidator.validate(query, 'safe').ok).toBe(false);
    const permissions = new PermissionManager(); permissions.setSafetyLevel('safe');
    expect(permissions.check('run_database_query', { query })).toBe('deny');
  });

  it('preserves the disposable records after the reported comment bypass and mode switches', async () => {
    const connector = await fixture();
    try {
      connector.setSafetyLevel('safe');
      await expect(connector.executeQuery('/* audit */ DELETE FROM items RETURNING id --')).rejects.toThrow();
      expect((await connector.executeQuery('SELECT * FROM items')).rowCount).toBe(3);
      // Prove the underlying handle also refuses writes if the classifier is bypassed.
      const handle = Reflect.get(connector, 'db') as Database.Database;
      expect(handle.readonly).toBe(true);
      expect(() => handle.prepare('DELETE FROM items').run()).toThrow(/readonly/i);
      connector.setSafetyLevel('standard');
      await connector.executeQuery('DELETE FROM items WHERE id = 3');
      expect((await connector.executeQuery('SELECT * FROM items')).rowCount).toBe(2);
    } finally { connector.close(); }
  });

  it('stops a runaway native SQLite query without blocking the parent event loop', async () => {
    const connector = await fixture(150);
    connector.setSafetyLevel('safe');
    const started = performance.now();
    let eventLoopResponded = false;
    const tick = setTimeout(() => { eventLoopResponded = true; }, 20);
    try {
      await expect(connector.executeQuery('WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT SUM(n) FROM numbers')).rejects.toThrow(/deadline.*stopped/);
      expect(eventLoopResponded).toBe(true);
      expect(performance.now() - started).toBeLessThan(2000);
      expect((await connector.executeQuery('SELECT * FROM items')).rowCount).toBe(3);
    } finally { clearTimeout(tick); connector.close(); }
  });

  it('propagates web cancellation to the SQLite process immediately', async () => {
    const inner = await fixture();
    const connector = new WebPolicyConnector(inner, 100, 10000);
    const controller = new AbortController();
    const pending = connector.executeQuery('WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT SUM(n) FROM numbers', { signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    try { await rejected; } finally { connector.close(); }
  });

  it('closing the connector terminates its active query process', async () => {
    const connector = await fixture();
    const pending = connector.executeQuery('WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT SUM(n) FROM numbers');
    const stopped = expect(pending).rejects.toThrow(/stopped/);
    connector.close();
    await stopped;
  });

  it('handles final semicolons, comments, CTEs and existing LIMIT/OFFSET without duplicate limits', async () => {
    const connector = await fixture();
    try {
      expect((await connector.executeQuery('SELECT * FROM items ORDER BY id LIMIT 1; -- final')).rows).toEqual([{ id: 1, name: 'one' }]);
      expect((await connector.executeQuery('WITH selected AS (SELECT * FROM items) SELECT * FROM selected ORDER BY id LIMIT 1 OFFSET 1;')).rows).toEqual([{ id: 2, name: 'two' }]);
      expect(classifyQuery("SELECT 'DELETE; DROP TABLE items' AS text")).toBe('read');
    } finally { connector.close(); }
  });

  it('applies the web cap in the database and records truncation truthfully', async () => {
    const inner = await fixture();
    const connector = new WebPolicyConnector(inner, 2, 10000);
    try {
      const result = await connector.executeQuery('SELECT * FROM items ORDER BY id');
      expect(result).toMatchObject({ rowCount: 2, truncated: true, rowLimit: 2 });
      expect(result.rows.map(row => row.id)).toEqual([1, 2]);
      expect((await connector.executeQuery('SELECT * FROM items LIMIT 2;')).truncated).not.toBe(true);
    } finally { connector.close(); }
  });

  it('returns the largest whole-row prefix that fits the web byte budget', async () => {
    const inner: DatabaseConnector = {
      connect: async () => {}, introspect: async () => ({ kind: 'sqlite', label: '', tables: [] }),
      executeQuery: async () => ({ columns: ['value'], rows: [{ value: 'a'.repeat(30) }, { value: 'b'.repeat(30) }], rowCount: 2, elapsedMs: 1 }),
      getContextForPrompt: async () => '', setSafetyLevel() {}, close() {}
    };
    const result = await new WebPolicyConnector(inner, 100, 130).executeQuery('select 1');
    expect(result).toMatchObject({ truncated: true, byteLimit: 130, truncationReason: 'byte-limit' });
    expect(result.rows.length).toBeLessThan(2);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(130);
  });

  it.each([
    { collection: 'items', method: 'deleteOne', filter: { id: 1 } },
    { collection: 'items', method: 'insertOne', document: { id: 1 } },
    { index: 'items', operation: 'delete', id: '1' },
    { index: 'items', operation: 'update', id: '1', body: { doc: { status: 'done' } } }
  ])('requires Standard approval for structured writes: %j', input => {
    const permissions = new PermissionManager();
    expect(permissions.check('run_database_query', { query: JSON.stringify(input) })).toBe('ask');
    permissions.setSafetyLevel('safe');
    expect(permissions.check('run_database_query', { query: JSON.stringify(input) })).toBe('deny');
  });

  it('denies mixed-dialect envelopes that could hide a write behind a read classification', () => {
    const permissions = new PermissionManager();
    const query = JSON.stringify({ collection: 'items', method: 'find', body: {}, index: 'items', operation: 'delete', id: '1' });
    expect(permissions.check('run_database_query', { query })).toBe('deny');
  });

  it('blocks nested Mongo writes and server-side JavaScript in read operations', async () => {
    const connector = new MongoDBConnector(); connector.setSafetyLevel('safe');
    await expect(connector.executeQuery(JSON.stringify({ collection: 'items', method: 'find', body: { filter: { $where: 'dangerous()' } } }))).rejects.toThrow(/blocked/i);
    expect(classifyQuery(JSON.stringify({ collection: 'items', method: 'aggregate', body: { pipeline: [{ $facet: { nested: [{ $out: 'other' }] } }] } }))).toBe('unknown');
  });

  it('adds a terminal Mongo limit after expanding stages and reports truncation', async () => {
    const aggregate = vi.fn(() => ({ toArray: async () => [{ a: 1 }, { a: 2 }, { a: 3 }] }));
    const connector = new MongoDBConnector(); connector.setResultLimit(2);
    Reflect.set(connector, 'db', { collection: () => ({ aggregate }) });
    const result = await connector.executeQuery(JSON.stringify({ collection: 'items', method: 'aggregate', body: { pipeline: [{ $limit: 99999 }, { $unwind: '$items' }] } }));
    expect(aggregate.mock.calls[0]).toEqual([[{ $limit: 99999 }, { $unwind: '$items' }, { $limit: 3 }], { maxTimeMS: 30000 }]);
    expect(result).toMatchObject({ rowCount: 2, truncated: true, rowLimit: 2 });
  });

  it('overrides caller-supplied Elasticsearch size before sending the request', async () => {
    const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'POST'
      ? { hits: { total: { value: 9 }, hits: [{ _id: '1' }, { _id: '2' }, { _id: '3' }] } } : {})));
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ElasticsearchConnector(); connector.setResultLimit(2);
    await connector.connect({ id: 'test', kind: 'elasticsearch', label: 'test', elasticsearchHost: 'example.invalid', createdAt: '' });
    const result = await connector.executeQuery(JSON.stringify({ index: 'items', body: { size: 999999, timeout: '1h' } }));
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ size: 3, timeout: '30s' });
    expect(result).toMatchObject({ rowCount: 2, truncated: true, rowLimit: 2 });
  });

  it.each(['sqlite', 'postgres', 'mysql', 'mongodb', 'elasticsearch'] as const)('samples %s using its own query syntax', async kind => {
    const executeQuery = vi.fn(async (_query: string) => ({ columns: ['id'], rows: [{ id: 1 }], rowCount: 1, elapsedMs: 0 }));
    const schema: DatabaseSchema = { kind, label: 'test', tables: [{ name: 'items', columns: [] }] };
    const connector: DatabaseConnector = { executeQuery, introspect: async () => schema, connect: async () => {}, close() {}, setSafetyLevel() {}, getContextForPrompt: async () => '' };
    const result = await sampleDataTool.execute({ tableName: 'items', mode: 'rows', limit: 3 }, { connector, schema } as ToolContext);
    expect(result.ok).toBe(true);
    const query = executeQuery.mock.calls[0][0];
    if (kind === 'mongodb') expect(JSON.parse(query)).toMatchObject({ collection: 'items', method: 'find', body: { limit: 3 } });
    else if (kind === 'elasticsearch') expect(JSON.parse(query)).toMatchObject({ index: 'items', body: { size: 3 } });
    else expect(query).toBe(`SELECT * FROM ${kind === 'mysql' ? '`items`' : '"items"'} LIMIT 3`);
  });
});
