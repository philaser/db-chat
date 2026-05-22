import { describe, expect, it } from 'vitest';
import { validateElasticsearchReadOnlyQuery } from '../src/main/connectors/elasticsearchValidation';

describe('validateElasticsearchReadOnlyQuery', () => {
  it('allows read-only search JSON', () => {
    const validation = validateElasticsearchReadOnlyQuery(JSON.stringify({
      index: 'orders-*',
      body: {
        size: 25,
        query: { match_all: {} },
        sort: [{ created_at: 'desc' }]
      }
    }), 'safe');

    expect(validation.safe).toBe(true);
    expect(validation.normalizedQuery).toContain('"index": "orders-*"');
  });

  it.each([
    JSON.stringify({ path: '/orders/_delete_by_query', body: { query: { match_all: {} } } }),
    JSON.stringify({ index: '../orders', body: { query: { match_all: {} } } }),
    JSON.stringify({ index: 'orders', body: { script_fields: { score: { script: '1 + 1' } } } }),
    JSON.stringify({ index: 'orders', body: { size: 1000, query: { match_all: {} } } })
  ])('blocks unsafe Elasticsearch query: %s', (query) => {
    expect(validateElasticsearchReadOnlyQuery(query, 'safe').safe).toBe(false);
  });

  it.each([
    JSON.stringify({ index: 'orders', operation: 'index', body: { customer: 'Ada' } }),
    JSON.stringify({ index: 'orders', operation: 'update', id: '1', body: { doc: { customer: 'Ada' } } }),
    JSON.stringify({ index: 'orders', operation: 'delete', id: '1' })
  ])('allows document writes with SAFE mode off: %s', (query) => {
    expect(validateElasticsearchReadOnlyQuery(query, 'manual').safe).toBe(true);
  });

  it.each([
    JSON.stringify({ path: '/orders/_delete_by_query', body: { query: { match_all: {} } } }),
    JSON.stringify({ index: 'orders-*', operation: 'delete', id: '1' }),
    JSON.stringify({ index: 'orders', operation: 'update', id: '1', body: { script: 'ctx._source.x = 1' } }),
    JSON.stringify({ index: 'orders', operation: 'drop', id: '1' })
  ])('blocks higher-level or unvalidated write shapes with SAFE mode off: %s', (query) => {
    expect(validateElasticsearchReadOnlyQuery(query, 'manual').safe).toBe(false);
  });
});
