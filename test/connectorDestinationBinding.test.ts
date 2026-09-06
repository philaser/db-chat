// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PostgresConnector } from '../src/server/connectors/PostgresConnector';
import { MySQLConnector } from '../src/server/connectors/MySQLConnector';
import { MongoDBConnector } from '../src/server/connectors/MongoDBConnector';
import type { ConnectionConfig } from '../src/shared/types';
const mocks = vi.hoisted(() => ({ postgres: vi.fn(), mysql: vi.fn(), mongo: vi.fn(), socket: vi.fn() }));
vi.mock('pg', () => ({ Client: class { constructor(options: unknown) { mocks.postgres(options); } async connect() {} async end() {} } }));
vi.mock('mysql2/promise', () => ({ createPool: (options: unknown) => { mocks.mysql(options); return { getConnection: async () => ({ ping: async () => {}, release() {} }), end: async () => {} }; } }));
vi.mock('mongodb', () => ({ MongoClient: class { constructor(uri: string, options: unknown) { mocks.mongo(uri, options); } async connect() {} db() { return {}; } async close() {} } }));
vi.mock('node:net', async original => ({ ...await original<typeof import('node:net')>(), connect: mocks.socket }));
const config = (kind: ConnectionConfig['kind']): ConnectionConfig => ({ id: 'test', kind, host: 'customer.example', resolvedAddress: '1.1.1.1', port: 1234, database: 'analytics', ssl: true, label: 'Customer data', createdAt: '2026-09-05' });

describe('validated destination binding', () => {
  it('Postgres connects to the checked IP and verifies the original TLS hostname', async () => {
    const connector = new PostgresConnector(); await connector.connect(config('postgres'));
    expect(mocks.postgres).toHaveBeenCalledWith(expect.objectContaining({ host: '1.1.1.1', ssl: { rejectUnauthorized: true, servername: 'customer.example' } }));
    connector.close();
  });
  it('MySQL opens its socket on the checked IP while retaining TLS identity', async () => {
    const connector = new MySQLConnector(); await connector.connect(config('mysql'));
    const options = mocks.mysql.mock.calls[0][0];
    expect(options).toMatchObject({ host: 'customer.example', ssl: { rejectUnauthorized: true, verifyIdentity: true } });
    options.stream();
    expect(mocks.socket).toHaveBeenCalledWith({ host: '1.1.1.1', port: 1234 });
    connector.close();
  });
  it('Mongo retains the customer hostname and overrides discovery and DNS', async () => {
    const connector = new MongoDBConnector();
    const uri = 'mongodb://customer.example/db?directConnection=false';
    await connector.connect({ ...config('mongodb'), mongodbUri: uri, mongodbDirectConnection: true });
    expect(mocks.mongo.mock.calls[0][0]).toBe(uri);
    const options = mocks.mongo.mock.calls[0][1];
    expect(options.directConnection).toBe(true);
    const callback = vi.fn(); options.lookup('customer.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '1.1.1.1', family: 4 }]);
    connector.close();
  });
});
