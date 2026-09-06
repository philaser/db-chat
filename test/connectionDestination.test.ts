// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { assertConnectionDestination, isPublicAddress, prepareConnectionDestination } from '../src/server/connectionPolicy';
import { pinnedLookup } from '../src/server/connectors/pinnedLookup';
import type { ConnectionConfig } from '../src/shared/types';
const connection = (extra: Partial<ConnectionConfig> = {}): ConnectionConfig => ({ id: 'test', kind: 'postgres', host: 'customer.example', label: 'Customer data', createdAt: '2026-09-05', ...extra });

describe('customer-owned hosted destinations', () => {
  it('allows public addresses and rejects private, mapped, transition and reserved forms', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isPublicAddress(address), address).toBe(true);
    for (const address of ['0.0.0.0', '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '192.0.2.5', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff00::1', '2001:db8::1', '2001:0db8::1', '2002:7f00:1::', '3fff:0001::']) expect(isPublicAddress(address), address).toBe(false);
  });
  it('checks every DNS answer before pinning a public destination', async () => {
    const c = connection();
    const resolve = vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    await expect(prepareConnectionDestination(c, [], resolve)).rejects.toThrow('private or reserved');
    expect(c.resolvedAddress).toBeUndefined();
    resolve.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    await prepareConnectionDestination(c, [], resolve);
    expect(resolve).toHaveBeenCalledWith('customer.example', { all: true, verbatim: true });
    expect(c.resolvedAddress).toBe('1.1.1.1');
  });
  it('matches Elasticsearch explicit host precedence to its connector', async () => {
    const resolve = vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);
    await prepareConnectionDestination(connection({ kind: 'elasticsearch', elasticsearchHost: 'actual.example', elasticsearchUrl: 'https://unused.example' }), [], resolve);
    expect(resolve).toHaveBeenCalledWith('actual.example', expect.anything());
    await expect(prepareConnectionDestination(connection({ kind: 'elasticsearch', elasticsearchUrl: 'http://127.0.0.1' }), [], resolve)).rejects.toThrow('private');
  });
  it('forces direct Mongo connections and rejects URI side channels before DNS', async () => {
    const c = connection({ kind: 'mongodb', mongodbUri: 'mongodb://user:password@customer.example/db?tls=true&authSource=admin&directConnection=false' });
    assertConnectionDestination(c);
    expect(c.mongodbDirectConnection).toBe(true);
    for (const options of ['proxyHost=127.0.0.1', 'tlsCAFile=/etc/passwd', 'tlsCertificateKeyFile=/tmp/key', 'authMechanism=MONGODB-AWS']) {
      expect(() => assertConnectionDestination(connection({ kind: 'mongodb', mongodbUri: `mongodb://customer.example/db?${options}` }))).toThrow();
    }
  });
  it('returns only the checked address even when a client requests all DNS answers', () => {
    const lookup = pinnedLookup('1.1.1.1');
    const callback = vi.fn();
    lookup('later-rebinding.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
  });
});
