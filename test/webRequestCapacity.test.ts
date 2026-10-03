// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountStore } from '../src/server/accountStore';
import { loadWebServerConfig } from '../src/server/config';
import { WebServer } from '../src/server/server';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(users = 1) {
  const directory = await mkdtemp(path.join(tmpdir(), 'dbchat-capacity-'));
  await writeFile(path.join(directory, 'index.html'), '<!doctype html><title>Capacity fixture</title>');
  const accounts = new AccountStore({ defaultModel: 'fixture', sessionTtlMs: 3600_000, secretKey: 'fixture' });
  const owners = Array.from({ length: users }, (_, index) => accounts.signup(`capacity-${index}@example.test`, 'fixture-password'));
  const server = new WebServer({ ...loadWebServerConfig({ DBCHAT_WEB_AUTH_MODE: 'app' }), port: 0, maxConcurrentRequests: 1, staticDir: directory }, { accounts });
  cleanup.push(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const handle = await server.listen();
  const base = 'http://127.0.0.1:' + (handle.address() as AddressInfo).port;
  const headers = (index = 0) => ({ cookie: 'dbchat_auth_session=' + owners[index].sessionId });
  return { accounts, owners, server, handle, base, headers };
}

it('rejects excess pending API work, preserves health/static access, and holds an abandoned handler until it settles', async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const list = vi.spyOn(f.server.accounts, 'listConnections').mockImplementationOnce(async () => { await gate; return []; });
  const controller = new AbortController();
  const pending = fetch(f.base + '/api/v1/connections', { headers: f.headers(), signal: controller.signal });
  const aborted = expect(pending).rejects.toThrow();
  try {
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    const busy = await fetch(f.base + '/api/v1/connections', { headers: f.headers() });
    expect(busy.status).toBe(503);
    expect(busy.headers.get('retry-after')).toBe('1');
    expect((await busy.json()).error).toContain('try again');
    expect((await fetch(f.base + '/api/health')).status).toBe(200);
    expect((await fetch(f.base + '/api/v1/health')).status).toBe(200);
    expect((await fetch(f.base + '/')).status).toBe(200);
    controller.abort(); await aborted;
    expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(503);
    expect(list).toHaveBeenCalledOnce();
  } finally { release(); controller.abort(); }
  await vi.waitFor(async () => expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(200));
  list.mockImplementationOnce(async () => { throw new Error('Synthetic read failure'); });
  expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(500);
  expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(200);
});

it('keeps buffered large responses inside the API allowance until the reader disconnects', async () => {
  const f = await fixture();
  const connection = f.accounts.createConnection(f.owners[0].user.id, { id: '', createdAt: '', kind: 'sqlite', label: 'Fixture', databasePath: ':memory:' });
  vi.spyOn(f.server.accounts, 'listConnections').mockImplementationOnce(async () => [{ ...connection, label: 'x'.repeat(16 * 1024 * 1024) }]);
  let outgoing: http.ServerResponse | undefined;
  f.handle.once('request', (_request, response) => { outgoing = response; });
  const incoming = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get(f.base + '/api/v1/connections', { headers: f.headers() }, response => { response.pause(); resolve(response); });
    request.once('error', reject);
  });
  try {
    expect(incoming.statusCode).toBe(200);
    await vi.waitFor(() => expect(outgoing?.writableLength).toBeGreaterThan(0));
    expect(outgoing?.writableFinished).toBe(false);
    expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(503);
    expect((await fetch(f.base + '/api/health')).status).toBe(200);
  } finally { incoming.destroy(); }
  await vi.waitFor(async () => expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(200));
});

it('caps event streams by owner and globally, releases normal API capacity, and releases a disconnected/error stream exactly once', async () => {
  const f = await fixture(9);
  const turns = f.owners.map(owner => f.server.sessions.createTurn({ id: owner.user.id, roles: ['user'] }, [{ role: 'user', content: 'Fixture question' }]));
  const controllers: AbortController[] = [];
  const open = async (index: number, id = turns[index].id) => {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(f.base + '/api/v1/chat/turns/' + id + '/events', { headers: f.headers(index), signal: controller.signal });
    if (response.status !== 200) await response.text();
    return { response, controller };
  };
  try {
    // Failed lookup must not consume lifetime stream capacity.
    expect((await open(0, 'missing')).response.status).toBe(404);
    expect((await open(0, 'also-missing')).response.status).toBe(404);
    const first = await open(0); expect(first.response.status).toBe(200);
    expect((await open(0)).response.status).toBe(200);
    const ownerBusy = (await open(0)).response;
    expect(ownerBusy.status).toBe(429);
    expect(ownerBusy.headers.get('retry-after')).toBe('1');
    for (let owner = 1; owner < 8; owner++) {
      expect((await open(owner)).response.status).toBe(200);
      expect((await open(owner)).response.status).toBe(200);
    }
    expect((await open(8)).response.status).toBe(429);
    expect((await fetch(f.base + '/api/v1/connections', { headers: f.headers() })).status).toBe(200);
    first.controller.abort();
    await vi.waitFor(() => expect(turns[0].subscribers.size).toBe(1));
    expect((await open(8)).response.status).toBe(200);
    const stream = [...turns[8].subscribers][0];
    stream.destroy(new Error('Synthetic stream transport failure'));
    await vi.waitFor(() => expect(turns[8].subscribers.size).toBe(0));
    expect((await open(8)).response.status).toBe(200);
    // The error and subsequent close must release only one global slot.
    expect((await open(8)).response.status).toBe(429);
  } finally { for (const controller of controllers) controller.abort(); }
});

it('validates the request concurrency setting before startup', () => {
  expect(loadWebServerConfig({}).maxConcurrentRequests).toBe(8);
  expect(loadWebServerConfig({ DBCHAT_WEB_MAX_CONCURRENT_REQUESTS: '32' }).maxConcurrentRequests).toBe(32);
  for (const value of ['0', '-1', '1.5', '129', 'Infinity', 'NaN', '']) {
    expect(() => loadWebServerConfig({ DBCHAT_WEB_MAX_CONCURRENT_REQUESTS: value })).toThrow('integer from 1 to 128');
  }
});

it('does not allocate legacy session records or cookies for v1 requests', async () => {
  const f = await fixture();
  const create = vi.spyOn(f.server.sessions, 'getOrCreateSession');
  for (let request = 0; request < 3; request++) {
    const response = await fetch(f.base + '/api/v1/connections', { headers: f.headers() });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBeNull();
  }
  expect(create).not.toHaveBeenCalled();
  const legacy = await fetch(f.base + '/api/connections', { headers: f.headers() });
  expect(legacy.status).toBe(200);
  expect(legacy.headers.get('set-cookie')).toContain('dbchat_web_session=');
  expect(create).toHaveBeenCalledOnce();
});
