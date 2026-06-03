import { describe, expect, it, vi } from 'vitest';
import { MongoDBConnector } from '../src/main/connectors/MongoDBConnector';

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
        findOne: async () => ({ _id: 'document-id', name })
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
});
