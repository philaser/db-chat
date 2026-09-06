// @vitest-environment node
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElasticsearchConnector } from '../src/server/connectors/ElasticsearchConnector';

afterEach(() => vi.restoreAllMocks());
describe('Elasticsearch checked transport', () => {
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
