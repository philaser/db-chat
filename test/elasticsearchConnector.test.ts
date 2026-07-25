import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchConnector } from '../src/main/connectors/ElasticsearchConnector';

describe('ElasticsearchConnector', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('introspects mappings and executes safe searches', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/_cluster/health?filter_path=cluster_name,status')) {
        return jsonResponse({ cluster_name: 'test', status: 'green' });
      }
      if (url.endsWith('/_cat/indices?format=json&h=index&s=index')) {
        return jsonResponse([{ index: 'orders' }]);
      }
      if (url.endsWith('/orders/_mapping')) {
        return jsonResponse({
          orders: {
            mappings: {
              properties: {
                customer: { type: 'keyword' },
                total: { type: 'double' }
              }
            }
          }
        });
      }
      if (url.endsWith('/orders/_search')) {
        return jsonResponse({
          took: 3,
          hits: {
            total: { value: 1 },
            hits: [{
              _index: 'orders',
              _id: '1',
              _score: 1,
              _source: { customer: 'Ada', total: 42 }
            }]
          }
        });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ElasticsearchConnector();
    await connector.connect({
      id: 'test',
      kind: 'elasticsearch',
      label: 'local-es',
      elasticsearchHost: 'localhost',
      elasticsearchPort: 9200,
      createdAt: new Date().toISOString()
    });

    const schema = await connector.introspect();
    expect(schema.kind).toBe('elasticsearch');
    expect(schema.tables[0].name).toBe('orders');
    expect(schema.tables[0].columns.map((column) => column.name)).toContain('customer');

    const result = await connector.executeQuery(JSON.stringify({
      index: 'orders',
      body: {
        size: 10,
        query: { match_all: {} }
      }
    }));

    expect(result.rows).toEqual([{
      _index: 'orders',
      _id: '1',
      _score: 1,
      customer: 'Ada',
      total: 42
    }]);
    expect(result.elapsedMs).toBe(3);
  });

  it('introspects every visible index instead of truncating large clusters', async () => {
    const indices = Array.from({ length: 55 }, (_, index) => ({ index: `orders-${String(index).padStart(2, '0')}` }));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/_cluster/health?filter_path=cluster_name,status')) {
        return jsonResponse({ cluster_name: 'test', status: 'green' });
      }
      if (url.endsWith('/_cat/indices?format=json&h=index&s=index')) {
        return jsonResponse([{ index: '.security' }, ...indices]);
      }
      if (url.endsWith('/_mapping')) {
        const indexName = decodeURIComponent(url.split('/').at(-2) ?? '');
        return jsonResponse({
          [indexName]: {
            mappings: {
              properties: {
                customer: { type: 'keyword' }
              }
            }
          }
        });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ElasticsearchConnector();
    await connector.connect({
      id: 'large-cluster',
      kind: 'elasticsearch',
      label: 'local-es',
      elasticsearchHost: 'localhost',
      elasticsearchPort: 9200,
      createdAt: new Date().toISOString()
    });

    const schema = await connector.introspect();

    expect(schema.tables).toHaveLength(55);
    expect(schema.tables.map((table) => table.name)).toContain('orders-54');
    expect(schema.tables.map((table) => table.name)).not.toContain('.security');
  });

  it('executes validated document writes when SAFE mode is off', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/_cluster/health?filter_path=cluster_name,status')) {
        return jsonResponse({ cluster_name: 'test', status: 'green' });
      }
      if (url.endsWith('/orders/_doc') && init?.method === 'POST') {
        return jsonResponse({ _index: 'orders', _id: '2', _version: 1, result: 'created' });
      }
      return jsonResponse({ error: 'not found' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    const connector = new ElasticsearchConnector();
    await connector.connect({
      id: 'test-write',
      kind: 'elasticsearch',
      label: 'local-es',
      elasticsearchHost: 'localhost',
      elasticsearchPort: 9200,
      createdAt: new Date().toISOString()
    });

    const result = await connector.executeQuery(JSON.stringify({
      index: 'orders',
      operation: 'index',
      body: { status: 'paid' }
    }));

    expect(result.rows).toEqual([{
      operation: 'index',
      index: 'orders',
      id: '2',
      result: 'created',
      version: 1
    }]);
  });

  it('reports each address when Elasticsearch host connections aggregate-fail', async () => {
    const ipv6Error = Object.assign(new Error('connect ECONNREFUSED ::1:9200'), {
      code: 'ECONNREFUSED',
      address: '::1',
      port: 9200
    });
    const ipv4Error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9200'), {
      code: 'ECONNREFUSED',
      address: '127.0.0.1',
      port: 9200
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed', {
        cause: new AggregateError([ipv6Error, ipv4Error])
      });
    }));

    const connector = new ElasticsearchConnector();
    await expect(connector.connect({
      id: 'aggregate-test',
      kind: 'elasticsearch',
      label: 'local-es',
      elasticsearchHost: 'localhost',
      elasticsearchPort: 9200,
      createdAt: new Date().toISOString()
    })).rejects.toThrow(
      'Could not reach Elasticsearch at http://localhost:9200: ECONNREFUSED ::1:9200; ECONNREFUSED 127.0.0.1:9200'
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
