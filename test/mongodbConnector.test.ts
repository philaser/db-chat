import { describe, expect, it, vi } from 'vitest';
import { MongoDBConnector } from '../src/server/connectors/MongoDBConnector';

describe('MongoDBConnector', () => {
  it('introspects every visible collection instead of truncating large databases', async () => {
    const collections = Array.from({ length: 55 }, (_, index) => ({ name: `collection_${String(index).padStart(2, '0')}` }));
    const db = {
      listCollections: () => ({
        toArray: async () => [
          { name: 'system.profile' },
          { name: '_internal' },
          ...collections
        ]
      }),
      collection: vi.fn((name: string) => ({
        find: () => ({ limit: () => ({ toArray: async () => [{ _id: 'document-id', name }] }) })
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
    const limit = vi.fn(() => ({ toArray: async () => [{ _id: 'one', count: 1 }, { _id: 'two', count: 'two', sparse: null }] }));
    const find = vi.fn(() => ({ limit }));
    const connector = new MongoDBConnector();
    Object.assign(connector, { db: { listCollections: () => ({ toArray: async () => [{ name: 'events' }] }), collection: () => ({ find }) } });
    const schema = await connector.introspect();
    expect(limit).toHaveBeenCalledWith(20);
    expect(find).toHaveBeenCalledWith({}, expect.objectContaining({ maxTimeMS: 30_000 }));
    expect(schema.inference).toMatchObject({ partial: true, sampledDocuments: 2, maxDocuments: 20 });
    expect(schema.tables[0].inference).toMatchObject({ partial: true, sampledDocuments: 2 });
    expect(schema.tables[0].columns.find(column => column.name === 'count')).toMatchObject({ type: 'number | string', nullable: false });
    expect(schema.tables[0].columns.find(column => column.name === 'sparse')).toMatchObject({ type: 'null', nullable: true });
    expect(await connector.getContextForPrompt()).toContain('Sparse fields may be absent');
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
