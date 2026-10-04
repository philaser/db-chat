import { describe, expect, it, vi } from 'vitest';
import { MongoDBConnector } from '../src/server/connectors/MongoDBConnector';

function cursor<T>(rows: T[]) { return { limit() { return this; }, close: vi.fn(async () => {}), async *[Symbol.asyncIterator]() { yield* rows; } }; }

describe('MongoDBConnector', () => {
  it('introspects every visible collection instead of truncating large databases', async () => {
    const collections = Array.from({ length: 55 }, (_, index) => ({ name: `collection_${String(index).padStart(2, '0')}` }));
    const db = {
      listCollections: () => cursor([
          { name: 'system.profile' },
          { name: '_internal' },
          ...collections
        ]),
      collection: vi.fn((name: string) => ({
        find: () => cursor([{ _id: 'document-id', name }])
      }))
    };
    const connector = new MongoDBConnector();
    (connector as unknown as {
      db: typeof db;
      config: { label: string };
    }).db = db;
    (connector as unknown as {
      config: { label: string };
    }).config = { label: 'large-mongo' };

    const schema = await connector.introspect();

    expect(schema.kind).toBe('mongodb');
    expect(schema.tables).toHaveLength(55);
    expect(schema.tables.map((table) => table.name)).toContain('collection_54');
    expect(schema.tables.map((table) => table.name)).not.toContain('system.profile');
    expect(schema.tables[0].columns.find((column) => column.name === '_id')?.primaryKey).toBe(true);
  });

  it('labels sparse mixed-type inference and bounds every collection sample', async () => {
    const limit = vi.fn(() => cursor([{ _id: 'one', count: 1 }, { _id: 'two', count: 'two', sparse: null }]));
    const find = vi.fn(() => ({ limit }));
    const connector = new MongoDBConnector();
    Object.assign(connector, { db: { listCollections: () => cursor([{ name: 'events' }]), collection: () => ({ find }) } });
    const schema = await connector.introspect();
    expect(limit).toHaveBeenCalledWith(20);
    expect(find).toHaveBeenCalledWith({}, expect.objectContaining({ maxTimeMS: 30_000 }));
    expect(schema.inference).toMatchObject({ partial: true, sampledDocuments: 2, maxDocuments: 20 });
    expect(schema.tables[0].inference).toMatchObject({ partial: true, sampledDocuments: 2 });
    expect(schema.tables[0].columns.find(column => column.name === 'count')).toMatchObject({ type: 'number | string', nullable: false });
    expect(schema.tables[0].columns.find(column => column.name === 'sparse')).toMatchObject({ type: 'null', nullable: true });
    expect(await connector.getContextForPrompt()).toContain('Sparse fields may be absent');
  });

  it('stops accumulating documents at the byte limit and closes the cursor', async () => {
    const close = vi.fn(async () => {});
    let consumed = 0;
    const docs = {
      limit() { return this; }, close,
      async *[Symbol.asyncIterator]() { for (let i = 0; i < 100; i++) { consumed++; yield { value: 'x'.repeat(1024 * 1024) }; } }
    };
    const connector = new MongoDBConnector();
    Object.assign(connector, { db: { collection: () => ({ find: () => docs }) } });
    await expect(connector.executeQuery(JSON.stringify({ collection: 'events', method: 'find', body: { limit: 100 } }))).rejects.toThrow(/response exceeded the size limit/);
    expect(consumed).toBe(8);
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes cancellation signals to every read operation', async () => {
    const signal = AbortSignal.abort(new DOMException('stopped', 'AbortError'));
    const countDocuments = vi.fn().mockRejectedValue(signal.reason);
    const connector = new MongoDBConnector();
    Object.assign(connector, { db: { collection: () => ({ countDocuments }) } });

    await expect(connector.executeQuery(JSON.stringify({
      collection: 'events', method: 'count', body: { filter: {} }
    }), { signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(countDocuments).toHaveBeenCalledWith({}, expect.objectContaining({ signal }));
  });

});
