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
});
