import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchConnector } from '../src/server/connectors/ElasticsearchConnector';
import { MongoDBConnector } from '../src/server/connectors/MongoDBConnector';
import { MySQLConnector } from '../src/server/connectors/MySQLConnector';
import { PostgresConnector } from '../src/server/connectors/PostgresConnector';
import { SQLiteConnector } from '../src/server/connectors/SQLiteConnector';
import type { QueryResult } from '../src/shared/types';

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })); vi.unstubAllGlobals(); });

async function allRows(source: AsyncIterable<{ rows: Record<string, unknown>[] }>) {
  const rows: Record<string, unknown>[] = [];
  for await (const batch of source) rows.push(...batch.rows);
  return rows;
}

describe('connector streaming exports', () => {
  it('exports more than the preview cap from SQLite and preserves an explicit LIMIT', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dbchat-export-')); dirs.push(dir);
    const databasePath = path.join(dir, 'rows.db');
    const db = new Database(databasePath);
    db.exec('create table items(id integer);');
    const insert = db.prepare('insert into items values (?)');
    db.transaction(() => { for (let i = 0; i < 1_205; i++) insert.run(i); })();
    db.close();
    const connector = new SQLiteConnector();
    await connector.connect({ id: 'sqlite', kind: 'sqlite', label: 'sqlite', databasePath, createdAt: '' });
    try {
      expect(await allRows(connector.exportQuery('select * from items order by id', { batchSize: 113 }))).toHaveLength(1_205);
      expect(await allRows(connector.exportQuery('select * from items order by id limit 7'))).toHaveLength(7);
      const empty: QueryResult[] = [];
      for await (const batch of connector.exportQuery('select id from items where 0')) empty.push(batch);
      expect(empty).toEqual([expect.objectContaining({ columns: ['id'], rows: [] })]);
      await expect(allRows(connector.exportQuery('delete from items'))).rejects.toThrow(/read-only/);
    } finally { connector.close(); }
  });

  it('cancels a SQLite export blocked before its first row without freezing the host', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dbchat-export-cancel-')); dirs.push(dir);
    const databasePath = path.join(dir, 'rows.db');
    const db = new Database(databasePath); db.exec('create table items(id integer);'); db.close();
    const connector = new SQLiteConnector(5_000);
    await connector.connect({ id: 'sqlite-cancel', kind: 'sqlite', label: 'sqlite', databasePath, createdAt: '' });
    const controller = new AbortController();
    let hostTicked = false;
    setTimeout(() => { hostTicked = true; controller.abort(); }, 20);
    const started = performance.now();
    try {
      await expect(allRows(connector.exportQuery('WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 1000000000) SELECT SUM(n) AS total FROM numbers', { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
      expect(hostTicked).toBe(true);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally { connector.close(); }
  });

  it('uses and closes a PostgreSQL cursor when a consumer stops early', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('FETCH')) return { rows: [{ id: 1 }, { id: 2 }], fields: [{ name: 'id' }], command: 'FETCH', rowCount: 2 };
      return { rows: [], fields: [], command: sql.split(' ')[0], rowCount: 0 };
    });
    const connector = new PostgresConnector(); Object.assign(connector, { client: { query } });
    const iterator = connector.exportQuery('select * from events limit 1005; -- keep', { batchSize: 2 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.rows).toHaveLength(2);
    await iterator.return?.();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('select * from events limit 1005; -- keep'))).toBe(true);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
    await expect(allRows(connector.exportQuery('update events set id = 2'))).rejects.toThrow(/read-only/);
  });

  it('streams MySQL rows from the driver without buffering the complete result', async () => {
    const stream = {
      destroyed: false,
      destroy() { this.destroyed = true; },
      on(_event: string, listener: (fields: Array<{ name: string }>) => void) { listener([{ name: 'id' }]); },
      off() {},
      async *[Symbol.asyncIterator]() { for (let id = 0; id < 1_101; id++) yield { id }; }
    };
    const rawQuery = vi.fn(() => ({ stream: () => stream }));
    const connector = new MySQLConnector();
    Object.assign(connector, { connection: { query: vi.fn(async () => [[], []]), ping: vi.fn(), connection: { query: rawQuery } } });
    expect(await allRows(connector.exportQuery('select * from events', { batchSize: 128 }))).toHaveLength(1_101);
    expect(stream.destroyed).toBe(true);
    await expect(allRows(connector.exportQuery('insert into events values (1)'))).rejects.toThrow(/read-only/);
  });

  it('destroys MySQL connection state when a consumer stops a live stream early', async () => {
    const destroy = vi.fn();
    const end = vi.fn(async () => undefined);
    const stream = {
      destroyed: false, destroy() { this.destroyed = true; }, on() {}, off() {},
      async *[Symbol.asyncIterator]() { for (let id = 0; id < 10; id++) yield { id }; }
    };
    const connection = { query: vi.fn(async () => [[], []]), ping: vi.fn(), destroy, connection: { query: () => ({ stream: () => stream }) } };
    const connector = new MySQLConnector(); Object.assign(connector, { connection, pool: { end }, config: {} });
    const iterator = connector.exportQuery('select * from events', { batchSize: 2 })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(destroy).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
    expect(Reflect.get(connector, 'connection')).toBeNull();
  });

  it('streams MongoDB cursors and closes them after completion', async () => {
    const close = vi.fn(async () => undefined);
    const cursor = {
      limit: vi.fn(function (this: unknown) { return this; }), close,
      async *[Symbol.asyncIterator]() { for (let id = 0; id < 1_050; id++) yield { _id: id, id }; }
    };
    const connector = new MongoDBConnector(); Object.assign(connector, { db: { collection: () => ({ find: () => cursor }) } });
    const query = JSON.stringify({ collection: 'events', method: 'find', body: {} });
    expect(await allRows(connector.exportQuery(query, { batchSize: 200 }))).toHaveLength(1_050);
    expect(close).toHaveBeenCalledOnce();
    await expect(allRows(connector.exportQuery(JSON.stringify({ collection: 'events', method: 'deleteOne', filter: {} })))).rejects.toThrow(/read-only/);
  });

  it('closes a MongoDB cursor when export cancellation is observed', async () => {
    const close = vi.fn(async () => undefined);
    const cursor = {
      limit() { return this; }, close,
      async *[Symbol.asyncIterator]() { for (let id = 0; id < 10; id++) yield { id }; }
    };
    const connector = new MongoDBConnector(); Object.assign(connector, { db: { collection: () => ({ find: () => cursor }) } });
    const controller = new AbortController();
    const query = JSON.stringify({ collection: 'events', method: 'find', body: {} });
    const iterator = connector.exportQuery(query, { batchSize: 2, signal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort(new DOMException('Stopped.', 'AbortError'));
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('pages Elasticsearch with a scroll and clears server state', async () => {
    let page = 0;
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('_cluster/health')) return json({ status: 'green' });
      if (init?.method === 'DELETE') return json({ succeeded: true });
      const count = page < 2 ? 500 : page === 2 ? 25 : 0;
      page++;
      return json({ _scroll_id: 'scroll-1', hits: { hits: Array.from({ length: count }, (_, id) => ({ _id: `${page}-${id}`, _source: { id } })) } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ElasticsearchConnector();
    await connector.connect({ id: 'es', kind: 'elasticsearch', label: 'es', elasticsearchHost: 'localhost', createdAt: '' });
    const query = JSON.stringify({ index: 'events', body: { query: { match_all: {} } } });
    expect(await allRows(connector.exportQuery(query, { batchSize: 500 }))).toHaveLength(1_025);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
    await expect(allRows(connector.exportQuery(JSON.stringify({ index: 'events', operation: 'delete', id: '1' })))).rejects.toThrow(/read-only/);
  });

  it.each([
    [{ timed_out: true, hits: { hits: [] } }, /timed out/],
    [{ terminated_early: true, hits: { hits: [] } }, /terminated early/],
    [{ _shards: { failed: 1 }, hits: { hits: [] } }, /failed on 1 shard/],
    [{ hits: { hits: [{ _id: '1', _source: { id: 1 } }] } }, /scroll cursor/]
  ])('rejects partial Elasticsearch export responses: %j', async (response, expected) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => String(input).includes('_cluster/health') ? json({ status: 'green' }) : json(response)));
    const connector = new ElasticsearchConnector();
    await connector.connect({ id: 'es-partial', kind: 'elasticsearch', label: 'es', elasticsearchHost: 'localhost', createdAt: '' });
    await expect(allRows(connector.exportQuery(JSON.stringify({ index: 'events', body: { query: { match_all: {} } } })))).rejects.toThrow(expected as RegExp);
  });

  it('rejects aggregation exports because bucket limits cannot prove raw completeness', async () => {
    const connector = new ElasticsearchConnector();
    await expect(allRows(connector.exportQuery(JSON.stringify({ index: 'events', body: { aggs: { by_status: { terms: { field: 'status' } } } } })))).rejects.toThrow(/do not support aggregations/);
  });
});

function json(body: unknown) { return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }); }
