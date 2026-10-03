// @vitest-environment node
import { EventEmitter } from 'node:events';
import https from 'node:https';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchConnector } from '../src/server/connectors/ElasticsearchConnector';

afterEach(() => vi.restoreAllMocks());
describe('Elasticsearch checked transport', () => {
  it('frames scroll cleanup bodies and preserves subsequent exports on a real HTTP connection', async () => {
    const deleted: string[] = [];
    const server = http.createServer(async (request, response) => {
      try {
        let body = '';
        for await (const chunk of request) body += chunk;
        response.setHeader('content-type', 'application/json');
        if (request.method === 'DELETE') {
          deleted.push(JSON.parse(body).scroll_id);
          response.end('{}');
        } else if (request.url?.includes('/orders/_search')) {
          response.end(JSON.stringify({ _scroll_id: 'cursor-é', hits: { hits: [{ _id: '1', _source: { total: 42 } }] } }));
        } else if (request.url === '/_search/scroll') {
          response.end(JSON.stringify({ _scroll_id: 'cursor-é', hits: { hits: [] } }));
        } else response.end('{}');
      } catch { response.statusCode = 400; response.end('{}'); }
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture failed to bind');
    const connector = new ElasticsearchConnector();
    try {
      await connector.connect({ id: 'framing', kind: 'elasticsearch', label: 'Framing fixture', createdAt: '2026-10-03', elasticsearchHost: 'customer.example', elasticsearchPort: address.port, resolvedAddress: '127.0.0.1' });
      for (let run = 0; run < 2; run++) {
        let rows = 0;
        for await (const batch of connector.exportQuery(JSON.stringify({ index: 'orders', body: { query: { match_all: {} } } }))) rows += batch.rowCount;
        expect(rows).toBe(1);
      }
      expect(deleted).toEqual(['cursor-é', 'cursor-é']);
    } finally {
      connector.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.each([200, 302])('pins DNS, keeps TLS hostname, and never follows redirects (HTTP %s)', async status => {
    let capturedUrl: URL | undefined;
    let capturedOptions: Record<string, any> | undefined;
    const request = vi.spyOn(https, 'request').mockImplementation(((url: URL, options: Record<string, any>, callback: (response: EventEmitter) => void) => {
      capturedUrl = url; capturedOptions = options;
      const response = Object.assign(new EventEmitter(), { statusCode: status, statusMessage: 'fixture', headers: status === 302 ? { location: 'http://127.0.0.1/private' } : {} });
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() { callback(response); response.emit('data', Buffer.from('{}')); response.emit('end'); }
      });
      return req;
    }) as unknown as typeof https.request);
    const connector = new ElasticsearchConnector();
    const connecting = connector.connect({ id: 'test', kind: 'elasticsearch', label: 'Customer', createdAt: '2026-09-05', elasticsearchHost: 'customer.example', elasticsearchUseSsl: true, resolvedAddress: '1.1.1.1' });
    if (status === 302) await expect(connecting).rejects.toThrow('302');
    else await connecting;
    expect(capturedUrl?.hostname).toBe('customer.example');
    expect(capturedOptions?.rejectUnauthorized).toBe(true);
    const callback = vi.fn(); capturedOptions?.lookup('customer.example', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '1.1.1.1', 4);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
